// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {VeylFeeHook} from "../hook/VeylFeeHook.sol";

/// @dev The deployed canonical PositionManager ABI, without importing its implementation.
interface IVeylPositionManager {
    function poolManager() external view returns (IPoolManager);
    function permit2() external view returns (address);
    function nextTokenId() external view returns (uint256);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IVeylPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice One-shot main VEYL token seeder. Its Uniswap v4 NFT belongs directly to the creator.
/// @dev This is NOT the permanently locked vault used by agent markets. It never owns the NFT.
/// Bootstrap settlement transfers tokens directly from this adapter to PoolManager through Permit2.
contract VeylMainLiquidityPosition is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant TARGET_SEED = 980_000_000 ether;
    uint256 public constant MAX_SEED_DUST = 1_000_000;
    address public constant CANONICAL_POSITION_MANAGER = 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e;
    address public constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public immutable factory;
    address public immutable refundRecipient;
    address public immutable tokenRefundRecipient;
    VeylFeeHook public immutable hook;
    IPoolManager public immutable poolManager;
    IERC20 public immutable token;
    address public immutable quoteAsset;
    bool public immutable tokenIsCurrency0;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    IVeylPositionManager public immutable positionManager;
    // ABI-compatible historical seed amount, not a custody/lock claim.
    uint128 public lockedLiquidity;
    uint256 public positionId;
    uint256 public seededTokens;
    bool public seeded;

    error InvalidConfiguration();
    error NotFactory();
    error AlreadySeeded();
    error SeedBounds();
    error SettlementMismatch();

    event MainPositionMinted(uint256 indexed tokenId, address indexed recipient, uint128 liquidity, uint256 tokensUsed);

    constructor(
        address factory_,
        VeylFeeHook hook_,
        address creator_,
        int24 lower_,
        int24 upper_,
        IVeylPositionManager manager_
    ) {
        if (
            factory_ == address(0) || creator_ == address(0) || address(hook_).code.length == 0
                || address(manager_) != CANONICAL_POSITION_MANAGER || address(manager_).code.length == 0
                || manager_.permit2() != CANONICAL_PERMIT2 || CANONICAL_PERMIT2.code.length == 0
                || address(manager_.poolManager()) != address(hook_.poolManager()) || hook_.quoteAsset() != address(0)
                || hook_.tokenIsCurrency0()
        ) revert InvalidConfiguration();
        int24 spacing = hook_.tickSpacing();
        if (
            lower_ < TickMath.MIN_TICK || upper_ > TickMath.MAX_TICK || lower_ >= upper_ || lower_ % spacing != 0
                || upper_ % spacing != 0
        ) revert InvalidConfiguration();
        factory = factory_;
        refundRecipient = creator_;
        tokenRefundRecipient = factory_;
        hook = hook_;
        poolManager = hook_.poolManager();
        token = IERC20(hook_.token());
        quoteAsset = address(0);
        tokenIsCurrency0 = false;
        tickLower = lower_;
        tickUpper = upper_;
        positionManager = manager_;
    }

    function seed(uint128 liquidity, uint256 maxToken, uint256 maxQuote, uint256 minToken, uint256 minQuote)
        external
        payable
        nonReentrant
        returns (uint256 quoteUsed, uint256 tokensUsed)
    {
        if (msg.sender != factory) revert NotFactory();
        if (seeded) revert AlreadySeeded();
        if (
            liquidity == 0 || liquidity > uint128(type(int128).max) || msg.value != 0 || maxQuote != 0 || minQuote != 0
                || minToken != TARGET_SEED || maxToken < TARGET_SEED || maxToken > TARGET_SEED + MAX_SEED_DUST
                || token.balanceOf(address(this)) != maxToken
        ) revert SeedBounds();
        seeded = true;
        lockedLiquidity = liquidity;
        positionId = positionManager.nextTokenId();
        uint256 managerBefore = token.balanceOf(address(poolManager));
        token.forceApprove(CANONICAL_PERMIT2, maxToken);
        IVeylPermit2(CANONICAL_PERMIT2)
            .approve(address(token), address(positionManager), uint160(maxToken), uint48(block.timestamp));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            hook.getPoolKey(),
            tickLower,
            tickUpper,
            uint256(liquidity),
            uint128(0),
            uint128(maxToken),
            refundRecipient,
            bytes("")
        );
        params[1] = abi.encode(Currency.wrap(address(0)), Currency.wrap(address(token)));
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR)), params),
            block.timestamp
        );
        tokensUsed = maxToken - token.balanceOf(address(this));
        // The approved allocation rounds UP to the smallest representable seed.
        // A mismatch reverts the complete launch; there is no parked dust or burn.
        if (
            tokensUsed != maxToken || token.balanceOf(address(poolManager)) != managerBefore + tokensUsed
                || positionManager.ownerOf(positionId) != refundRecipient
                || positionManager.getPositionLiquidity(positionId) != liquidity
        ) revert SettlementMismatch();
        token.forceApprove(CANONICAL_PERMIT2, 0);
        IVeylPermit2(CANONICAL_PERMIT2).approve(address(token), address(positionManager), 0, 0);
        seededTokens = tokensUsed;
        emit MainPositionMinted(positionId, refundRecipient, liquidity, tokensUsed);
        return (0, tokensUsed);
    }
}
