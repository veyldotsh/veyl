// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {VeylFeeHook} from "../hook/VeylFeeHook.sol";
import {VeylLiquidityVault} from "./VeylLiquidityVault.sol";
import {VeylProjectDeployer} from "./VeylProjectDeployer.sol";
import {VeylMarketDeployer} from "./VeylMarketDeployer.sol";
import {VeylLiquidityDeployer} from "./VeylLiquidityDeployer.sol";
import {VeylProjectBuilder} from "./VeylProjectBuilder.sol";
import {VeylMarketBuilder} from "./VeylMarketBuilder.sol";
import {VeylLiquidityBuilder} from "./VeylLiquidityBuilder.sol";
import {VeylSwapRouter} from "../VeylSwapRouter.sol";
import {VeylMarketTypes as T} from "./VeylMarketTypes.sol";
import {VeylQuoter} from "./VeylQuoter.sol";
import {VeylAgentLaunchMath as M} from "./VeylAgentLaunchMath.sol";

/// @notice Fixed-policy agent markets: all 1B supply allocated to permanent, token-only liquidity.
/// @dev Initial FDV is derived from the immutable main pool's current spot price inside execution.
/// This is not a TWAP or a manipulation-proof oracle. Microscopic rounding dust remains locked in the vault.
/// Existing factories and the main VEYL market are unchanged. Creators receive tokens only through a paid buy.
contract VeylAgentExecutionFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant TARGET_FDV_ETH = 2 ether;
    uint256 public constant MAX_SEED_DUST = 1_000_000;
    bool public constant EXECUTION_PRICED = true;
    uint256 public constant LAUNCH_POLICY_VERSION = 3;
    IPoolManager public immutable poolManager;
    address public immutable protocol;
    address public immutable quoteAsset;
    address public immutable conversionSwapRouter;
    VeylFeeHook public immutable referenceHook;
    VeylProjectBuilder public immutable projectBuilder;
    VeylMarketBuilder public immutable marketBuilder;
    VeylLiquidityBuilder public immutable liquidityBuilder;
    VeylProjectDeployer public immutable projectDeployer;
    VeylMarketDeployer public immutable marketDeployer;
    VeylLiquidityDeployer public immutable liquidityDeployer;
    VeylQuoter public immutable quoter;
    mapping(bytes32 => T.Market) private markets;

    error InvalidConfiguration();
    error AlreadyLaunched();
    error Expired();
    error IncorrectFunding();
    error FundingFailed();
    error SettlementMismatch();

    event MarketLaunched(
        bytes32 indexed id,
        address indexed creator,
        address indexed token,
        address treasury,
        address revenueRouter,
        address hook,
        address swapRouter,
        address liquidityVault,
        bytes32 poolId
    );
    event LaunchAllocation(
        bytes32 indexed id, uint256 treasuryEth, uint256 liquidityQuote, uint256 liquidityTokens, uint256 creatorTokens
    );
    event StandardLiquidityLocked(
        bytes32 indexed id,
        uint256 seededTokens,
        uint256 lockedDust,
        uint160 referenceSqrtPriceX96,
        uint256 startingFdvEth
    );
    event CreatorBought(bytes32 indexed id, address indexed creator, uint256 quotePaid, uint256 tokensBought);
    event StandardLaunchTerms(
        bytes32 indexed id, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity
    );

    constructor(
        IPoolManager manager_,
        address protocol_,
        VeylQuoter quoter_,
        address quoteAsset_,
        address conversionSwapRouter_,
        VeylProjectBuilder projectBuilder_,
        VeylMarketBuilder marketBuilder_,
        VeylLiquidityBuilder liquidityBuilder_
    ) {
        if (
            address(manager_).code.length == 0 || protocol_ == address(0) || address(quoter_).code.length == 0
                || quoteAsset_.code.length == 0 || conversionSwapRouter_.code.length == 0
                || address(projectBuilder_).code.length == 0 || address(marketBuilder_).code.length == 0
                || address(liquidityBuilder_).code.length == 0 || address(quoter_.poolManager()) != address(manager_)
                || address(projectBuilder_.poolManager()) != address(manager_)
                || address(marketBuilder_.poolManager()) != address(manager_)
                || address(liquidityBuilder_.poolManager()) != address(manager_)
        ) revert InvalidConfiguration();
        VeylSwapRouter conversion = VeylSwapRouter(payable(conversionSwapRouter_));
        VeylFeeHook ref = conversion.hook();
        if (
            address(conversion.token()) != quoteAsset_ || conversion.quoteAsset() != address(0)
                || address(conversion.poolManager()) != address(manager_) || ref.token() != quoteAsset_
                || ref.quoteAsset() != address(0) || address(ref.poolManager()) != address(manager_)
                || PoolId.unwrap(ref.poolId()) != PoolId.unwrap(conversion.poolId()) || !ref.poolInitialized()
        ) revert InvalidConfiguration();
        poolManager = manager_;
        protocol = protocol_;
        quoteAsset = quoteAsset_;
        conversionSwapRouter = conversionSwapRouter_;
        referenceHook = ref;
        projectBuilder = projectBuilder_;
        marketBuilder = marketBuilder_;
        liquidityBuilder = liquidityBuilder_;
        projectDeployer = projectBuilder_.deploy(protocol_, quoteAsset_, conversionSwapRouter_);
        marketDeployer = marketBuilder_.deploy(quoteAsset_);
        liquidityDeployer = liquidityBuilder_.deploy();
        if (
            projectDeployer.factory() != address(this) || projectDeployer.protocol() != protocol_
                || projectDeployer.poolManager() != address(manager_) || projectDeployer.quoteAsset() != quoteAsset_
                || projectDeployer.conversionSwapRouter() != conversionSwapRouter_
                || marketDeployer.factory() != address(this)
                || address(marketDeployer.poolManager()) != address(manager_)
                || marketDeployer.quoteAsset() != quoteAsset_ || liquidityDeployer.factory() != address(this)
                || address(liquidityDeployer.poolManager()) != address(manager_)
        ) revert InvalidConfiguration();
        quoter = quoter_;
    }

    function marketId(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function getMarket(bytes32 id) external view returns (T.Market memory) {
        return markets[id];
    }

    /// @notice Preserves identity, treasury controls, salt and deadline; derives all economic launch fields.
    function standardLaunchConfig(address creator, T.LaunchConfig calldata request)
        external
        view
        returns (
            T.LaunchConfig memory config,
            uint256 actualStartingFdvEth,
            uint256 tokensUsed,
            uint256 lockedDust,
            uint160 referenceSqrtPriceX96
        )
    {
        (config, tokensUsed, referenceSqrtPriceX96) = _derive(creator, request);
        lockedDust = TOKEN_SUPPLY - tokensUsed;
        (address token,,) = projectDeployer.predict(marketId(creator, config.salt), creator, config);
        actualStartingFdvEth = M.startingFdv(config, token < quoteAsset, referenceSqrtPriceX96);
    }

    /// @notice Quote the exact first buy before deployment, without token funding or allowances.
    function previewInitialBuy(
        address creator,
        T.LaunchConfig calldata request,
        uint256 buyQuoteAmount,
        uint160 buyPriceLimit
    ) external view returns (uint256 tokensOut, uint256 hookFee, uint160 sqrtPriceX96After) {
        (T.LaunchConfig memory config,,) = _derive(creator, request);
        (address token,,) = projectDeployer.predict(marketId(creator, config.salt), creator, config);
        return M.initialBuy(config, token < quoteAsset, buyQuoteAmount, buyPriceLimit);
    }

    /// @notice Token, hook and router addresses are stable; the vault preview changes with the current range.
    function predictLaunch(address creator, T.LaunchConfig calldata request, bytes32 hookSalt)
        external
        view
        returns (bytes32 id, T.Market memory market, bytes32 hookInitCodeHash)
    {
        (T.LaunchConfig memory config,,) = _derive(creator, request);
        id = marketId(creator, config.salt);
        market.creator = creator;
        market.treasuryOwner = config.treasuryOwner;
        market.quoteAsset = quoteAsset;
        (market.token, market.treasury, market.revenueRouter) = projectDeployer.predict(id, creator, config);
        (market.hook, market.swapRouter, hookInitCodeHash) =
            marketDeployer.predict(id, hookSalt, market.token, market.revenueRouter, config);
        // Only the factory can receive seed rounding refunds, then it permanently locks them back in this vault.
        market.liquidityVault = liquidityDeployer.predict(id, market.hook, address(this), config);
        market.poolId = PoolId.unwrap(
            PoolIdLibrary.toId(
                PoolKey(
                    Currency.wrap(market.token < quoteAsset ? market.token : quoteAsset),
                    Currency.wrap(market.token < quoteAsset ? quoteAsset : market.token),
                    0,
                    1,
                    IHooks(market.hook)
                )
            )
        );
    }

    function launch(T.LaunchConfig calldata config, bytes32 hookSalt)
        external
        payable
        nonReentrant
        returns (bytes32 id, T.Market memory market)
    {
        (id, market,) = _launch(config, hookSalt);
    }

    /// @notice Optional atomic paid creator buy. Only exact approved VEYL is pulled; ordinary hook fees apply.
    function launchAndBuy(
        T.LaunchConfig calldata config,
        bytes32 hookSalt,
        uint256 buyQuoteAmount,
        uint256 minBuyTokens,
        uint160 buyPriceLimit
    ) external payable nonReentrant returns (bytes32 id, T.Market memory market, uint256 tokensBought) {
        if (minBuyTokens == 0) revert InvalidConfiguration();
        T.LaunchConfig memory actual;
        (id, market, actual) = _launch(config, hookSalt);
        // Bounded preview rejects partial fills and limits the maximum bitmap traversal for this atomic path.
        (uint256 quoted,,) = M.initialBuy(actual, market.token < quoteAsset, buyQuoteAmount, buyPriceLimit);
        if (quoted < minBuyTokens) revert IncorrectFunding();
        tokensBought = _creatorBuy(market, buyQuoteAmount, minBuyTokens, buyPriceLimit, actual.deadline);
        if (tokensBought != quoted) revert SettlementMismatch();
        emit CreatorBought(id, msg.sender, buyQuoteAmount, tokensBought);
    }

    function _launch(T.LaunchConfig calldata request, bytes32 hookSalt)
        private
        returns (bytes32 id, T.Market memory market, T.LaunchConfig memory config)
    {
        if (block.timestamp > request.deadline) revert Expired();
        if (msg.value != request.treasuryEth) revert IncorrectFunding();
        id = marketId(msg.sender, request.salt);
        if (markets[id].token != address(0)) revert AlreadyLaunched();
        uint160 referencePrice;
        uint256 expectedUsed;
        (config, expectedUsed, referencePrice) = _derive(msg.sender, request);
        market.creator = msg.sender;
        market.treasuryOwner = config.treasuryOwner;
        market.quoteAsset = quoteAsset;
        (market.token, market.treasury, market.revenueRouter) = projectDeployer.deploy(id, msg.sender, config);
        (market.hook, market.swapRouter) =
            marketDeployer.deploy(id, hookSalt, market.token, market.revenueRouter, config);
        market.liquidityVault = liquidityDeployer.deploy(id, market.hook, address(this), config);
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        market.poolId = PoolId.unwrap(hook.poolId());
        markets[id] = market;
        poolManager.initialize(hook.getPoolKey(), config.sqrtPriceX96);
        _lockInventory(market, config, expectedUsed);
        if (config.treasuryEth != 0) {
            (bool ok,) = market.treasury.call{value: config.treasuryEth}("");
            if (!ok) revert FundingFailed();
        }
        _announce(id, market, config, referencePrice, expectedUsed);
    }

    function _lockInventory(T.Market memory market, T.LaunchConfig memory config, uint256 expectedUsed) private {
        IERC20(market.token).safeTransfer(market.liquidityVault, TOKEN_SUPPLY);
        (uint256 quoteUsed, uint256 tokensUsed) = VeylLiquidityVault(market.liquidityVault)
            .seed(config.liquidity, TOKEN_SUPPLY, 0, TOKEN_SUPPLY - MAX_SEED_DUST, 0);
        uint256 dust = TOKEN_SUPPLY - tokensUsed;
        if (
            tokensUsed != expectedUsed || quoteUsed != 0 || dust > MAX_SEED_DUST
                || IERC20(market.token).balanceOf(address(this)) != dust
        ) revert SettlementMismatch();
        if (dust != 0) IERC20(market.token).safeTransfer(market.liquidityVault, dust);
        if (IERC20(market.token).balanceOf(market.liquidityVault) != dust) revert SettlementMismatch();
    }

    function _announce(
        bytes32 id,
        T.Market memory market,
        T.LaunchConfig memory config,
        uint160 referencePrice,
        uint256 tokensUsed
    ) private {
        emit MarketLaunched(
            id,
            msg.sender,
            market.token,
            market.treasury,
            market.revenueRouter,
            market.hook,
            market.swapRouter,
            market.liquidityVault,
            market.poolId
        );
        emit LaunchAllocation(id, config.treasuryEth, 0, tokensUsed, 0);
        emit StandardLaunchTerms(id, config.sqrtPriceX96, config.tickLower, config.tickUpper, config.liquidity);
        emit StandardLiquidityLocked(
            id,
            tokensUsed,
            TOKEN_SUPPLY - tokensUsed,
            referencePrice,
            M.startingFdv(config, market.token < quoteAsset, referencePrice)
        );
    }

    function _creatorBuy(T.Market memory market, uint256 quoteAmount, uint256 minOut, uint160 limit, uint256 deadline)
        private
        returns (uint256 bought)
    {
        IERC20 quote = IERC20(quoteAsset);
        uint256 beforeQuote = quote.balanceOf(address(this));
        uint256 beforeSender = quote.balanceOf(msg.sender);
        quote.safeTransferFrom(msg.sender, address(this), quoteAmount);
        if (
            quote.balanceOf(address(this)) != beforeQuote + quoteAmount
                || quote.balanceOf(msg.sender) + quoteAmount != beforeSender
        ) revert SettlementMismatch();
        quote.forceApprove(market.swapRouter, quoteAmount);
        bought = VeylSwapRouter(payable(market.swapRouter)).buy(quoteAmount, minOut, limit, deadline);
        quote.forceApprove(market.swapRouter, 0);
        if (quote.balanceOf(address(this)) != beforeQuote || IERC20(market.token).balanceOf(address(this)) != bought) {
            revert SettlementMismatch();
        }
        IERC20(market.token).safeTransfer(msg.sender, bought);
    }

    function _referencePrice() private view returns (uint160 price) {
        (price,,) = quoter.getPoolState(referenceHook);
        if (price == 0) revert InvalidConfiguration();
    }

    /// @dev Caller-provided prices, ranges, fees and allocation are never authoritative.
    /// A single current reference is read before deployment and used for all launch arithmetic.
    function _derive(address creator, T.LaunchConfig memory request)
        private
        view
        returns (T.LaunchConfig memory config, uint256 tokensUsed, uint160 referencePrice)
    {
        request.launchProtection = false;
        _identity(creator, request);
        (address token,,) = projectDeployer.predict(marketId(creator, request.salt), creator, request);
        referencePrice = _referencePrice();
        (config, tokensUsed) = M.standard(request, token < quoteAsset, referencePrice, quoter);
    }

    function _identity(address creator, T.LaunchConfig memory config) private pure {
        if (
            creator == address(0) || bytes(config.name).length == 0 || bytes(config.name).length > 64
                || bytes(config.symbol).length == 0 || bytes(config.symbol).length > 10
                || config.treasuryOwner == address(0)
        ) revert InvalidConfiguration();
    }
}
