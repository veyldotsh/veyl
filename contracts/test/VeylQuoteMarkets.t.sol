// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VeylMarketFixture} from "./VeylMarketFactory.t.sol";
import {AgentToken, AgentTreasury} from "../src/AgentKit.sol";
import {VeylMarketFactory} from "../src/market/VeylMarketFactory.sol";
import {VeylMarketTypes as T} from "../src/market/VeylMarketTypes.sol";
import {VeylQuoter} from "../src/market/VeylQuoter.sol";
import {VeylLiquidityVault} from "../src/market/VeylLiquidityVault.sol";
import {VeylLiquidityDeployer} from "../src/market/VeylLiquidityDeployer.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";
import {QuoteRevenueRouter} from "../src/QuoteRevenueRouter.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// Native main market and agent markets are real local PoolManager positions.
/// Amounts/rates are deliberately test fixtures, not approved production terms.
contract VeylQuoteMarketsTest is VeylMarketFixture {
    address constant TRADER = address(0xB0B);
    AgentToken quote;
    T.Market mainMarket;
    VeylMarketFactory mainFactory;
    uint256 sequence;

    function setUp() public {
        _configure(IPoolManager(address(new PoolManager(address(this)))));
        vm.deal(address(this), 10_000 ether);
        mainMarket = _launch();
        mainFactory = factory;
        quote = AgentToken(mainMarket.token);
        factory = new VeylMarketFactory(
            manager,
            PLATFORM,
            mainFactory.quoter(),
            address(quote),
            mainMarket.swapRouter,
            projectBuilder,
            marketBuilder,
            liquidityBuilder
        );
        quote.approve(address(factory), type(uint256).max);
        quote.transfer(TRADER, 10_000 ether);
    }

    function _agent(bool token0) internal returns (T.Market memory market) {
        config.name = "Agent fixture";
        config.symbol = "AGT";
        config.maxToken = 1000 ether;
        config.maxQuote = 1000 ether;
        config.minToken = 1;
        config.minQuote = 1;
        config.treasuryEth = 1 ether;
        config.liquidity = 1000 ether;
        config.sqrtPriceX96 = 79228162514264337593543950336;
        config.tickLower = -600;
        config.tickUpper = 600;
        config.launchProtection = false;
        uint256 nonce = ++sequence;
        for (uint256 i; i < 100; ++i) {
            config.salt = keccak256(abi.encode("agent quote fixture", nonce, i));
            bytes32 candidateId = factory.marketId(address(this), config.salt);
            (address candidate,,) = factory.projectDeployer().predict(candidateId, address(this), config);
            if ((candidate < address(quote)) == token0) break;
            if (i == 99) revert("fixture ordering search exhausted");
        }
        hookSalt = _mine(address(this), config);
        (bytes32 id, T.Market memory predicted,) = factory.predictLaunch(address(this), config, hookSalt);
        uint256 beforeQuote = quote.balanceOf(address(this));
        (, market) = factory.launch{value: config.treasuryEth}(config, hookSalt);
        assertEq(market.token, predicted.token);
        assertEq(market.revenueRouter, predicted.revenueRouter);
        assertEq(market.liquidityVault, predicted.liquidityVault);
        assertEq(market.poolId, predicted.poolId);
        assertEq(market.quoteAsset, address(quote));
        assertEq(factory.getMarket(id).quoteAsset, address(quote));
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        assertEq(hook.tokenIsCurrency0(), token0);
        PoolKey memory key = hook.getPoolKey();
        assertEq(Currency.unwrap(key.currency0), token0 ? market.token : address(quote));
        assertEq(Currency.unwrap(key.currency1), token0 ? address(quote) : market.token);
        (uint256 amount0, uint256 amount1) =
            factory.quoter().previewSeed(config.sqrtPriceX96, config.tickLower, config.tickUpper, config.liquidity);
        assertEq(beforeQuote - quote.balanceOf(address(this)), token0 ? amount1 : amount0);
        assertEq(AgentToken(market.token).balanceOf(address(manager)), token0 ? amount0 : amount1);
        assertEq(
            AgentToken(market.token).balanceOf(address(this)) + AgentToken(market.token).balanceOf(address(manager)),
            1_000_000_000 ether
        );
        assertEq(quote.balanceOf(market.liquidityVault), 0);
        assertEq(AgentToken(market.token).balanceOf(market.liquidityVault), 0);
        assertEq(market.treasury.balance, config.treasuryEth);
        assertEq(market.revenueRouter.balance, 0);
        assertEq(VeylLiquidityVault(market.liquidityVault).quoteAsset(), address(quote));
        vm.startPrank(TRADER);
        quote.approve(market.swapRouter, type(uint256).max);
        AgentToken(market.token).approve(market.swapRouter, type(uint256).max);
        vm.stopPrank();
    }

    function _limit(bool token0, bool buy) internal pure returns (uint160) {
        return buy != token0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function testBothCurrencyOrdersSeedTradeConvertAllFeesAndPayETH() public {
        for (uint256 i; i < 2; ++i) {
            bool token0 = i == 0;
            T.Market memory market = _agent(token0);
            VeylFeeHook hook = VeylFeeHook(payable(market.hook));
            VeylSwapRouter swapper = VeylSwapRouter(payable(market.swapRouter));
            uint256 beforeQuote = quote.balanceOf(TRADER);
            VeylQuoter.Quote memory buyQuote =
                factory.quoter().quoteExactInput(hook, true, 1 ether, _limit(token0, true));
            vm.prank(TRADER);
            uint256 bought = swapper.buy(1 ether, buyQuote.amountOut, _limit(token0, true), block.timestamp);
            assertEq(bought, buyQuote.amountOut);
            assertEq(beforeQuote - quote.balanceOf(TRADER), 1 ether);
            VeylQuoter.Quote memory sellQuote =
                factory.quoter().quoteExactInput(hook, false, bought / 2, _limit(token0, false));
            vm.prank(TRADER);
            (uint256 sold, uint256 received) =
                swapper.sell(bought / 2, sellQuote.amountOut, _limit(token0, false), block.timestamp);
            assertEq(sold, sellQuote.amountIn);
            assertEq(received, sellQuote.amountOut);
            _convertAndPayout(market);
        }
    }

    function _convertAndPayout(T.Market memory market) internal {
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        QuoteRevenueRouter revenue = QuoteRevenueRouter(payable(market.revenueRouter));
        uint256 fees = hook.pendingFees();
        assertGt(fees, 0);
        assertEq(manager.balanceOf(market.hook, uint256(uint160(address(quote)))), fees);
        assertEq(manager.balanceOf(market.hook, 0), 0);
        assertEq(hook.flushFees(), fees);
        assertEq(hook.pendingFees(), 0);
        assertEq(revenue.pendingQuote(), fees);
        assertEq(quote.balanceOf(market.revenueRouter), fees);
        assertEq(quote.allowance(market.hook, market.revenueRouter), 0);
        assertEq(revenue.claimable(address(this)), 0);
        assertEq(revenue.claimable(PLATFORM), 0);
        vm.prank(TREASURY_OWNER);
        revenue.configureConversion(address(this), fees, fees, 1, true);
        VeylQuoter.Quote memory converted = mainFactory.quoter()
            .quoteExactInput(VeylFeeHook(payable(mainMarket.hook)), false, fees, TickMath.MAX_SQRT_PRICE - 1);
        uint256 ethOut =
            revenue.convertFees(fees, converted.amountOut, TickMath.MAX_SQRT_PRICE - 1, block.timestamp + 60);
        assertEq(ethOut, converted.amountOut);
        assertEq(revenue.pendingQuote(), 0);
        assertEq(quote.balanceOf(market.revenueRouter), 0);
        assertEq(quote.allowance(market.revenueRouter, mainMarket.swapRouter), 0);
        uint256 treasuryShare = ethOut * 7 / 10;
        uint256 creatorShare = ethOut / 5;
        uint256 protocolShare = ethOut - treasuryShare - creatorShare;
        assertEq(revenue.claimable(market.treasury), treasuryShare);
        assertEq(revenue.claimable(address(this)), creatorShare);
        assertEq(revenue.claimable(PLATFORM), protocolShare);
        uint256 treasuryBefore = market.treasury.balance;
        uint256 creatorBefore = address(this).balance;
        uint256 protocolBefore = PLATFORM.balance;
        revenue.distribute(market.treasury);
        revenue.distribute(address(this));
        revenue.distribute(PLATFORM);
        assertEq(market.treasury.balance - treasuryBefore, treasuryShare);
        assertEq(address(this).balance - creatorBefore, creatorShare);
        assertEq(PLATFORM.balance - protocolBefore, protocolShare);
        assertEq(market.revenueRouter.balance, 0);
    }

    function testExternalV4RouterAllSwapModesAndQuoteClaimsBothOrders() public {
        for (uint256 i; i < 2; ++i) {
            bool token0 = i == 0;
            T.Market memory market = _agent(token0);
            VeylFeeHook hook = VeylFeeHook(payable(market.hook));
            PoolSwapTest externalRouter = new PoolSwapTest(manager);
            AgentToken token = AgentToken(market.token);
            token.transfer(TRADER, 10 ether);
            vm.startPrank(TRADER);
            quote.approve(address(externalRouter), type(uint256).max);
            token.approve(address(externalRouter), type(uint256).max);
            vm.stopPrank();
            for (uint256 mode; mode < 4; ++mode) {
                _externalMode(hook, externalRouter, mode);
            }
            _convertAndPayout(market);
        }
    }

    function _externalMode(VeylFeeHook hook, PoolSwapTest externalRouter, uint256 mode) internal {
        bool buy = mode < 2;
        bool exactInput = mode % 2 == 0;
        AgentToken token = AgentToken(hook.token());
        uint256[3] memory before = [quote.balanceOf(TRADER), token.balanceOf(TRADER), hook.pendingFees()];
        SwapParams memory params = SwapParams(
            buy != hook.tokenIsCurrency0(),
            exactInput ? -int256(0.1 ether) : int256(0.1 ether),
            _limit(hook.tokenIsCurrency0(), buy)
        );
        PoolKey memory key = hook.getPoolKey();
        vm.prank(TRADER);
        externalRouter.swap(key, params, PoolSwapTest.TestSettings(false, false), "");
        assertGt(hook.pendingFees(), before[2]);
        if (buy) {
            assertLt(quote.balanceOf(TRADER), before[0]);
            assertGt(token.balanceOf(TRADER), before[1]);
            if (exactInput) assertEq(before[0] - quote.balanceOf(TRADER), 0.1 ether);
            else assertEq(token.balanceOf(TRADER) - before[1], 0.1 ether);
        } else {
            assertGt(quote.balanceOf(TRADER), before[0]);
            assertLt(token.balanceOf(TRADER), before[1]);
            if (exactInput) assertEq(before[1] - token.balanceOf(TRADER), 0.1 ether);
            else assertEq(quote.balanceOf(TRADER) - before[0], 0.1 ether);
        }
    }

    function testQuoteLaunchRejectsETHOverfundingAndMissingApprovalAtomically() public {
        _agent(false);
        config.salt = keccak256("rejected quote seed");
        bytes32 salt = _mine(address(this), config);
        (, T.Market memory predicted,) = factory.predictLaunch(address(this), config, salt);
        vm.expectRevert(VeylMarketFactory.IncorrectFunding.selector);
        factory.launch{value: config.treasuryEth + config.maxQuote}(config, salt);
        _assertAbsent(predicted);
        quote.approve(address(factory), 0);
        uint256 beforeQuote = quote.balanceOf(address(this));
        vm.expectRevert();
        factory.launch{value: config.treasuryEth}(config, salt);
        _assertAbsent(predicted);
        assertEq(quote.balanceOf(address(this)), beforeQuote);
    }

    function testFixedQuoteConfigurationAndUnauthorizedHelperCallsRejected() public {
        VeylQuoter fixedQuoter = mainFactory.quoter();
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        new VeylMarketFactory(
            manager,
            PLATFORM,
            fixedQuoter,
            address(0),
            mainMarket.swapRouter,
            projectBuilder,
            marketBuilder,
            liquidityBuilder
        );
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        new VeylMarketFactory(
            manager, PLATFORM, fixedQuoter, address(quote), address(0), projectBuilder, marketBuilder, liquidityBuilder
        );
        T.Market memory market = _agent(true);
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        new VeylMarketFactory(
            manager,
            PLATFORM,
            fixedQuoter,
            market.token,
            mainMarket.swapRouter,
            projectBuilder,
            marketBuilder,
            liquidityBuilder
        );
        VeylLiquidityDeployer vaultDeployer = factory.liquidityDeployer();
        vm.expectRevert();
        vaultDeployer.deploy(bytes32(uint256(1)), market.hook, address(this), config);
        assertEq(factory.projectDeployer().quoteAsset(), address(quote));
        assertEq(factory.projectDeployer().conversionSwapRouter(), mainMarket.swapRouter);
        assertEq(factory.marketDeployer().quoteAsset(), address(quote));
        assertEq(factory.liquidityDeployer().factory(), address(factory));
    }
}
