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
import {AgentToken} from "../AgentKit.sol";

/// @notice Atomic, permissionless market launch. Existing AgentFactory ABI remains unchanged.
/// @dev Creator is msg.sender; treasury ownership is explicit. Actual LP seed tokens are locked;
/// all remaining 1B supply belongs to the creator. Initial treasury ETH is never fee-split.
contract VeylMarketFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    IPoolManager public immutable poolManager;
    address public immutable protocol;
    address public immutable quoteAsset;
    address public immutable conversionSwapRouter;
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
                || address(projectBuilder_).code.length == 0 || address(marketBuilder_).code.length == 0
                || address(liquidityBuilder_).code.length == 0
        ) {
            revert InvalidConfiguration();
        }
        if (
            address(quoter_.poolManager()) != address(manager_)
                || address(projectBuilder_.poolManager()) != address(manager_)
                || address(marketBuilder_.poolManager()) != address(manager_)
                || address(liquidityBuilder_.poolManager()) != address(manager_)
        ) {
            revert InvalidConfiguration();
        }
        if (quoteAsset_ == address(0)) {
            if (conversionSwapRouter_ != address(0)) revert InvalidConfiguration();
        } else {
            if (quoteAsset_.code.length == 0 || conversionSwapRouter_.code.length == 0) revert InvalidConfiguration();
            VeylSwapRouter conversion = VeylSwapRouter(payable(conversionSwapRouter_));
            if (
                address(conversion.token()) != quoteAsset_ || conversion.quoteAsset() != address(0)
                    || address(conversion.poolManager()) != address(manager_)
            ) revert InvalidConfiguration();
            VeylFeeHook conversionHook = conversion.hook();
            if (
                conversionHook.token() != quoteAsset_ || conversionHook.quoteAsset() != address(0)
                    || address(conversionHook.poolManager()) != address(manager_)
                    || PoolId.unwrap(conversionHook.poolId()) != PoolId.unwrap(conversion.poolId())
            ) revert InvalidConfiguration();
        }
        poolManager = manager_;
        protocol = protocol_;
        quoteAsset = quoteAsset_;
        conversionSwapRouter = conversionSwapRouter_;
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
        ) {
            revert InvalidConfiguration();
        }
        quoter = quoter_;
    }

    function marketId(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function getMarket(bytes32 id) external view returns (T.Market memory) {
        return markets[id];
    }

    /// @notice Read-only deployment prediction. Mine a hookSalt whose hook has permission bits 0x20cc.
    function predictLaunch(address creator, T.LaunchConfig calldata config, bytes32 hookSalt)
        external
        view
        returns (bytes32 id, T.Market memory market, bytes32 hookInitCodeHash)
    {
        id = marketId(creator, config.salt);
        market.creator = creator;
        market.treasuryOwner = config.treasuryOwner;
        market.quoteAsset = quoteAsset;
        (market.token, market.treasury, market.revenueRouter) = projectDeployer.predict(id, creator, config);
        (market.hook, market.swapRouter, hookInitCodeHash) =
            marketDeployer.predict(id, hookSalt, market.token, market.revenueRouter, config);
        market.liquidityVault = liquidityDeployer.predict(id, market.hook, creator, config);
        market.poolId = PoolId.unwrap(
            PoolIdLibrary.toId(
                PoolKey(
                    Currency.wrap(market.token < quoteAsset ? market.token : quoteAsset),
                    Currency.wrap(market.token < quoteAsset ? quoteAsset : market.token),
                    config.lpFeePips,
                    config.tickSpacing,
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
        if (block.timestamp > config.deadline) revert Expired();
        if (
            bytes(config.name).length == 0 || bytes(config.name).length > 64 || bytes(config.symbol).length == 0
                || bytes(config.symbol).length > 10 || config.treasuryOwner == address(0)
                || config.maxToken > TOKEN_SUPPLY || config.minToken == 0 || config.minToken > config.maxToken
                || config.minQuote > config.maxQuote
        ) revert InvalidConfiguration();
        if (msg.value != config.treasuryEth + (quoteAsset == address(0) ? config.maxQuote : 0)) {
            revert IncorrectFunding();
        }
        id = marketId(msg.sender, config.salt);
        if (markets[id].token != address(0)) revert AlreadyLaunched();
        market.creator = msg.sender;
        market.treasuryOwner = config.treasuryOwner;
        market.quoteAsset = quoteAsset;
        (market.token, market.treasury, market.revenueRouter) = projectDeployer.deploy(id, msg.sender, config);
        (market.hook, market.swapRouter) =
            marketDeployer.deploy(id, hookSalt, market.token, market.revenueRouter, config);
        market.liquidityVault = liquidityDeployer.deploy(id, market.hook, msg.sender, config);
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        market.poolId = PoolId.unwrap(hook.poolId());
        markets[id] = market;
        poolManager.initialize(hook.getPoolKey(), config.sqrtPriceX96);
        if (config.launchProtection) {
            AgentToken(market.token).setBootstrapVault(market.liquidityVault);
        }
        IERC20(market.token).safeTransfer(market.liquidityVault, config.maxToken);
        if (quoteAsset != address(0) && config.maxQuote != 0) {
            IERC20 quote = IERC20(quoteAsset);
            uint256 beforeSender = quote.balanceOf(msg.sender);
            uint256 beforeVault = quote.balanceOf(market.liquidityVault);
            quote.safeTransferFrom(msg.sender, market.liquidityVault, config.maxQuote);
            if (
                quote.balanceOf(msg.sender) + config.maxQuote != beforeSender
                    || quote.balanceOf(market.liquidityVault) != beforeVault + config.maxQuote
            ) revert IncorrectFunding();
        }
        (uint256 quoteUsed, uint256 tokensUsed) = VeylLiquidityVault(market.liquidityVault)
        .seed{value: quoteAsset == address(0) ? config.maxQuote : 0}(
            config.liquidity, config.maxToken, config.maxQuote, config.minToken, config.minQuote
        );
        if (config.launchProtection) AgentToken(market.token).activate();
        // Guarded unused seed inputs returned here, so this is the entire actual
        // creator allocation and is subject to both launch caps after activation.
        IERC20(market.token).safeTransfer(msg.sender, IERC20(market.token).balanceOf(address(this)));
        if (config.treasuryEth != 0) {
            (bool ok,) = market.treasury.call{value: config.treasuryEth}("");
            if (!ok) revert FundingFailed();
        }
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
        emit LaunchAllocation(id, config.treasuryEth, quoteUsed, tokensUsed, TOKEN_SUPPLY - tokensUsed);
    }
}
