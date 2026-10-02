// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {AgentTreasury} from "./AgentKit.sol";

interface IQuoteConversionSwapRouter {
    function token() external view returns (address);
    function quoteAsset() external view returns (address);
    function poolManager() external view returns (address);
    function hook() external view returns (address);
    function poolId() external view returns (PoolId);
    function getPoolKey() external view returns (PoolKey memory);
    function sell(uint256 amountIn, uint256 minEthOut, uint160 limit, uint256 deadline)
        external
        returns (uint256 spent, uint256 received);
}

/// @notice All agent fee receipts convert from VEYL to ETH before the actual
/// ETH output is split 70% treasury /20% creator /10% platform, including rounding.
/// @dev An immutable, verified main VEYL/ETH router is selected at deployment.
/// Runtime identity verification is the deployment client's responsibility;
/// the constructor additionally checks its declared assets, pool and manager.
/// ETH claims pay only the immutable beneficiaries. The owner's price floor
/// is an explicit limit, not an oracle; stale or incompatible bounds halt swaps.
contract QuoteRevenueRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable quoteAsset;
    AgentTreasury public immutable treasury;
    address public immutable creator;
    address public immutable protocol;
    IQuoteConversionSwapRouter public immutable conversionSwapRouter;
    address public immutable poolManager;
    uint16 public constant treasuryBps = 7_000;
    uint16 public constant creatorBps = 2_000;
    uint16 public constant protocolBps = 1_000;
    uint256 public constant MAX_DEADLINE_SECONDS = 300;

    struct ConversionPolicy {
        address executor;
        uint256 maxQuotePerConversion;
        uint256 maxQuotePerDay;
        uint256 minEthPerVeylX18;
        bool enabled;
    }
    ConversionPolicy public conversionPolicy;
    mapping(address => uint256) public claimable;
    mapping(uint256 => uint256) public spentOnDay;
    uint256 public pendingQuote;
    bool private converting;

    error InvalidConfiguration();
    error NotTreasuryOwner();
    error ConversionDisabled();
    error NotConversionExecutor();
    error InvalidAmount();
    error InvalidDeadline();
    error BelowOwnerFloor();
    error ConversionLimitExceeded();
    error SettlementMismatch();
    error UnexpectedETH();
    error TransferFailed();

    event QuoteReceived(address indexed payer, uint256 amount);
    event Revenue(
        address indexed payer, uint256 amount, uint256 treasuryShare, uint256 creatorShare, uint256 protocolShare
    );
    event Claimed(address indexed beneficiary, address indexed destination, uint256 amount);
    event ConversionConfigured(
        address indexed owner,
        address indexed executor,
        uint256 maxQuotePerConversion,
        uint256 maxQuotePerDay,
        uint256 minEthPerVeylX18,
        bool enabled
    );
    event FeesConverted(address indexed executor, uint256 quoteSpent, uint256 ethReceived, uint256 indexed day);

    constructor(
        address quoteAsset_,
        AgentTreasury treasury_,
        address creator_,
        address protocol_,
        address conversionSwapRouter_
    ) {
        if (
            quoteAsset_.code.length == 0 || address(treasury_).code.length == 0 || creator_ == address(0)
                || protocol_ == address(0) || conversionSwapRouter_.code.length == 0
                || IERC20Metadata(quoteAsset_).decimals() != 18 || treasury_.owner() == address(0)
        ) revert InvalidConfiguration();
        IQuoteConversionSwapRouter router = IQuoteConversionSwapRouter(conversionSwapRouter_);
        address manager = router.poolManager();
        PoolKey memory key = router.getPoolKey();
        if (
            manager.code.length == 0 || router.token() != quoteAsset_ || router.quoteAsset() != address(0)
                || Currency.unwrap(key.currency0) != address(0) || Currency.unwrap(key.currency1) != quoteAsset_
                || address(key.hooks).code.length == 0 || address(key.hooks) != router.hook()
                || PoolId.unwrap(PoolIdLibrary.toId(key)) != PoolId.unwrap(router.poolId())
        ) revert InvalidConfiguration();
        quoteAsset = quoteAsset_;
        treasury = treasury_;
        creator = creator_;
        protocol = protocol_;
        conversionSwapRouter = router;
        poolManager = manager;
    }

    /// @notice Deposit with an exact temporary approval. Direct token transfers
    /// are not credited; only this call's measured receipt is eligible to convert.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        IERC20 asset = IERC20(quoteAsset);
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) != beforeBalance + amount) revert SettlementMismatch();
        pendingQuote += amount;
        emit QuoteReceived(msg.sender, amount);
    }

    function distribute(address beneficiary) external nonReentrant {
        _pay(beneficiary, beneficiary);
    }

    function claim(address destination) external nonReentrant {
        _pay(msg.sender, destination);
    }

    function _pay(address beneficiary, address destination) private {
        uint256 amount = claimable[beneficiary];
        if (amount == 0 || destination == address(0)) revert InvalidAmount();
        claimable[beneficiary] = 0;
        (bool ok,) = destination.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(beneficiary, destination, amount);
    }

    function configureConversion(
        address executor,
        uint256 maxQuotePerConversion,
        uint256 maxQuotePerDay,
        uint256 minEthPerVeylX18,
        bool enabled
    ) external nonReentrant {
        if (msg.sender != treasury.owner()) revert NotTreasuryOwner();
        if (
            enabled
                && (executor == address(0)
                    || maxQuotePerConversion == 0
                    || maxQuotePerDay < maxQuotePerConversion
                    || minEthPerVeylX18 == 0)
        ) revert InvalidConfiguration();
        conversionPolicy = ConversionPolicy(executor, maxQuotePerConversion, maxQuotePerDay, minEthPerVeylX18, enabled);
        emit ConversionConfigured(
            msg.sender, executor, maxQuotePerConversion, maxQuotePerDay, minEthPerVeylX18, enabled
        );
    }

    function convertFees(uint256 amountIn, uint256 minEthOut, uint160 sqrtPriceLimitX96, uint256 deadline)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        ConversionPolicy memory policy = conversionPolicy;
        if (!policy.enabled) revert ConversionDisabled();
        if (msg.sender != policy.executor && msg.sender != treasury.owner()) revert NotConversionExecutor();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_DEADLINE_SECONDS) revert InvalidDeadline();
        if (amountIn == 0 || amountIn > pendingQuote || minEthOut == 0 || sqrtPriceLimitX96 == 0) {
            revert InvalidAmount();
        }
        if (minEthOut < Math.mulDiv(amountIn, policy.minEthPerVeylX18, 1e18, Math.Rounding.Ceil)) {
            revert BelowOwnerFloor();
        }
        uint256 day = block.timestamp / 1 days;
        if (amountIn > policy.maxQuotePerConversion || spentOnDay[day] + amountIn > policy.maxQuotePerDay) {
            revert ConversionLimitExceeded();
        }
        pendingQuote -= amountIn;
        spentOnDay[day] += amountIn;
        IERC20 asset = IERC20(quoteAsset);
        uint256 quoteBefore = asset.balanceOf(address(this));
        uint256 ethBefore = address(this).balance;
        asset.forceApprove(address(conversionSwapRouter), amountIn);
        converting = true;
        (uint256 spent, uint256 received) = conversionSwapRouter.sell(amountIn, minEthOut, sqrtPriceLimitX96, deadline);
        converting = false;
        asset.forceApprove(address(conversionSwapRouter), 0);
        ethOut = address(this).balance - ethBefore;
        if (
            spent != amountIn || quoteBefore - asset.balanceOf(address(this)) != amountIn || received != ethOut
                || ethOut < minEthOut || asset.allowance(address(this), address(conversionSwapRouter)) != 0
        ) revert SettlementMismatch();
        _creditETH(ethOut);
        emit FeesConverted(msg.sender, amountIn, ethOut, day);
    }

    function _creditETH(uint256 amount) private {
        uint256 operating = Math.mulDiv(amount, treasuryBps, 10_000);
        uint256 human = Math.mulDiv(amount, creatorBps, 10_000);
        uint256 platform = amount - operating - human;
        claimable[address(treasury)] += operating;
        claimable[creator] += human;
        claimable[protocol] += platform;
        emit Revenue(msg.sender, amount, operating, human, platform);
    }

    receive() external payable {
        if (!converting || msg.sender != poolManager) revert UnexpectedETH();
    }
}
