// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VeylMarketFixture} from "./VeylMarketFactory.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {AgentToken} from "../src/AgentKit.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";
import {QuoteRevenueRouter} from "../src/QuoteRevenueRouter.sol";
import {VeylMarketFactory} from "../src/market/VeylMarketFactory.sol";
import {VeylAgentLaunchFactory} from "../src/market/VeylAgentLaunchFactory.sol";
import {VeylAgentLaunchMath as M} from "../src/market/VeylAgentLaunchMath.sol";
import {VeylLiquidityVault} from "../src/market/VeylLiquidityVault.sol";
import {VeylProjectBuilder} from "../src/market/VeylProjectBuilder.sol";
import {VeylMarketBuilder} from "../src/market/VeylMarketBuilder.sol";
import {VeylLiquidityBuilder} from "../src/market/VeylLiquidityBuilder.sol";
import {VeylQuoter} from "../src/market/VeylQuoter.sol";
import {VeylMarketTypes as T} from "../src/market/VeylMarketTypes.sol";

abstract contract StandardAgentFixture is VeylMarketFixture {
    using StateLibrary for IPoolManager;
    VeylAgentLaunchFactory standardFactory;
    T.Market mainMarket;
    uint256 sequence;

    struct BuyExpectation {
        uint256 used;
        uint256 dust;
        uint256 tokens;
        uint256 fee;
        uint160 price;
        uint256 beforeQuote;
        uint256 beforeFactoryQuote;
    }

    function _newFactory() internal {
        uint256 beforeGas = gasleft();
        standardFactory = new VeylAgentLaunchFactory(
            manager,
            PLATFORM,
            factory.quoter(),
            mainMarket.token,
            mainMarket.swapRouter,
            projectBuilder,
            marketBuilder,
            liquidityBuilder
        );
        emit log_named_uint("New factory plus3 children execution gas", beforeGas - gasleft());
    }

    function _standard(bool token0) internal returns (uint256 used, uint256 dust) {
        config.name = "Standard agent";
        config.symbol = "AGENT";
        config.treasuryEth = 0;
        config.dailyLimit = 0;
        config.operator = address(this);
        config.treasuryOwner = address(this);
        config.deadline = block.timestamp + 600;
        config.launchProtection = false;
        uint256 nonce = ++sequence;
        for (uint256 i; i < 256; ++i) {
            config.salt = keccak256(abi.encode("standard-agent", nonce, i));
            (address token,,) = standardFactory.projectDeployer()
                .predict(standardFactory.marketId(address(this), config.salt), address(this), config);
            if ((token < mainMarket.token) == token0) break;
            if (i == 255) revert("order search exhausted");
        }
        uint256 fdv;
        uint160 ref;
        (config, fdv, used, dust, ref) = standardFactory.standardLaunchConfig(address(this), config);
        assertGe(fdv, 19998e14);
        assertLe(fdv, 20002e14);
        assertGt(ref, 0);
        assertEq(used + dust, 1_000_000_000 ether);
        assertLe(dust, 1_000_000);
        assertEq(config.maxQuote, 0);
        assertEq(config.minQuote, 0);
        assertEq(config.maxToken, 1_000_000_000 ether);
        assertEq(config.tickSpacing, 1);
        assertFalse(config.launchProtection);
        hookSalt = _mineStandard();
    }

    function _mineStandard() internal view returns (bytes32) {
        (bytes32 id,, bytes32 hash) = standardFactory.predictLaunch(address(this), config, bytes32(0));
        for (uint256 i; i < 1_000_000; ++i) {
            address candidate = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(standardFactory.marketDeployer()),
                                keccak256(abi.encode(id, bytes32(i))),
                                hash
                            )
                        )
                    )
                )
            );
            if (uint160(candidate) & 0x3fff == 0x20cc) return bytes32(i);
        }
        revert("salt search exhausted");
    }

    function _limit(bool token0, bool buy) internal pure returns (uint160) {
        return buy != token0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _assertLocked(T.Market memory market, uint256 used, uint256 dust, uint256 paidTokens) internal view {
        IERC20 token = IERC20(market.token);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.balanceOf(address(manager)) + paidTokens, used);
        assertEq(token.balanceOf(market.liquidityVault), dust);
        assertEq(token.balanceOf(address(this)), paidTokens);
        assertEq(token.balanceOf(address(standardFactory)), 0);
        VeylLiquidityVault vault = VeylLiquidityVault(market.liquidityVault);
        assertEq(vault.refundRecipient(), address(standardFactory));
        assertEq(vault.tokenRefundRecipient(), address(standardFactory));
        assertEq(vault.lockedLiquidity(), config.liquidity);
        assertTrue(vault.seeded());
        (uint128 position,,) = manager.getPositionInfo(
            PoolId.wrap(market.poolId), market.liquidityVault, config.tickLower, config.tickUpper, bytes32(0)
        );
        assertEq(position, config.liquidity);
    }

    function _roundTrip(bool token0, uint256 quotePaid) internal {
        (T.Market memory market, uint256 bought) = _paidLaunch(token0, quotePaid);
        _sellAndConvert(market, bought, token0);
    }

    function _paidLaunch(bool token0, uint256 quotePaid) internal returns (T.Market memory market, uint256 bought) {
        BuyExpectation memory e;
        (e.used, e.dust) = _standard(token0);
        (e.tokens, e.fee, e.price) =
            standardFactory.previewInitialBuy(address(this), config, quotePaid, _limit(token0, true));
        IERC20(mainMarket.token).approve(address(standardFactory), quotePaid);
        e.beforeQuote = IERC20(mainMarket.token).balanceOf(address(this));
        e.beforeFactoryQuote = IERC20(mainMarket.token).balanceOf(address(standardFactory));
        (, T.Market memory predicted,) = standardFactory.predictLaunch(address(this), config, hookSalt);
        uint256 beforeGas = gasleft();
        bytes32 id;
        (id, market, bought) = standardFactory.launchAndBuy(config, hookSalt, quotePaid, e.tokens, _limit(token0, true));
        emit log_named_uint("Standard launch plus exact paid buy execution gas", beforeGas - gasleft());
        assertEq(abi.encode(market), abi.encode(predicted));
        assertEq(abi.encode(standardFactory.getMarket(id)), abi.encode(market));
        assertEq(bought, e.tokens);
        assertEq(e.beforeQuote - IERC20(mainMarket.token).balanceOf(address(this)), quotePaid);
        assertEq(IERC20(mainMarket.token).allowance(address(this), address(standardFactory)), 0);
        assertEq(IERC20(mainMarket.token).allowance(address(standardFactory), market.swapRouter), 0);
        assertEq(IERC20(mainMarket.token).balanceOf(address(standardFactory)), e.beforeFactoryQuote);
        _assertLocked(market, e.used, e.dust, bought);
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        assertEq(hook.pendingFees(), e.fee);
        (uint160 actualPrice,,) = standardFactory.quoter().getPoolState(hook);
        assertEq(actualPrice, e.price);
    }

    function _sellAndConvert(T.Market memory market, uint256 bought, bool token0) internal {
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        uint256 fee = hook.pendingFees();
        IERC20(market.token).approve(market.swapRouter, bought / 2);
        VeylQuoter.Quote memory sellQuote =
            standardFactory.quoter().quoteExactInput(hook, false, bought / 2, _limit(token0, false));
        (uint256 spent, uint256 received) = VeylSwapRouter(payable(market.swapRouter))
            .sell(bought / 2, sellQuote.amountOut, _limit(token0, false), block.timestamp);
        assertEq(spent, bought / 2);
        assertEq(received, sellQuote.amountOut);
        uint256 pending = hook.pendingFees();
        assertGt(pending, fee);
        assertEq(hook.flushFees(), pending);
        QuoteRevenueRouter revenue = QuoteRevenueRouter(payable(market.revenueRouter));
        assertEq(revenue.pendingQuote(), pending);
        revenue.configureConversion(address(this), pending, pending, 1, true);
        VeylQuoter.Quote memory convertQuote = standardFactory.quoter()
            .quoteExactInput(VeylFeeHook(payable(mainMarket.hook)), false, pending, TickMath.MAX_SQRT_PRICE - 1);
        uint256 ethOut =
            revenue.convertFees(pending, convertQuote.amountOut, TickMath.MAX_SQRT_PRICE - 1, block.timestamp + 60);
        assertEq(ethOut, convertQuote.amountOut);
        assertEq(revenue.claimable(market.treasury), ethOut * 70 / 100);
        assertEq(revenue.claimable(address(this)), ethOut * 20 / 100);
        assertEq(revenue.pendingQuote(), 0);
        assertEq(VeylLiquidityVault(market.liquidityVault).lockedLiquidity(), config.liquidity);
    }
}

contract VeylAgentLaunchFactoryTest is StandardAgentFixture {
    function setUp() public {
        _configure(IPoolManager(address(new PoolManager(address(this)))));
        vm.deal(address(this), 10_000 ether);
        mainMarket = _launch();
        _newFactory();
    }

    function testZeroQuoteLaunchLocksWholeSupplyWithNoCreatorTokensBothOrders() public {
        for (uint256 i; i < 2; ++i) {
            (uint256 used, uint256 dust) = _standard(i == 0);
            uint256 beforeQuote = IERC20(mainMarket.token).balanceOf(address(this));
            (, T.Market memory market) = standardFactory.launch(config, hookSalt);
            _assertLocked(market, used, dust, 0);
            assertEq(IERC20(mainMarket.token).balanceOf(address(this)), beforeQuote);
            vm.expectRevert();
            VeylLiquidityVault(market.liquidityVault).seed(config.liquidity, config.maxToken, 0, config.minToken, 0);
            (bool withdrawable,) =
                market.liquidityVault.call(abi.encodeWithSignature("withdraw(address)", address(this)));
            assertFalse(withdrawable);
        }
    }

    function testAtomicCreatorBuyMatchesExactWordRoundingThenSellAndConvertBothOrders() public {
        _roundTrip(true, 0.05 ether);
        _roundTrip(false, 0.05 ether);
    }

    function testLargerCreatorBuyMatchesQuoteAcrossManyBitmapWordsBothOrders() public {
        _roundTrip(true, 1 ether);
        _roundTrip(false, 1 ether);
    }

    function testFixedPolicyRejectsEveryEconomicOverride() public {
        _standard(false);
        T.LaunchConfig memory good = config;
        for (uint256 i; i < 13; ++i) {
            config = good;
            if (i == 0) config.maxToken--;
            if (i == 1) config.minToken--;
            if (i == 2) config.maxQuote = 1;
            if (i == 3) config.minQuote = 1;
            if (i == 4) config.buyFeeBps++;
            if (i == 5) config.sellFeeBps++;
            if (i == 6) config.lpFeePips = 1;
            if (i == 7) config.tickSpacing = 200;
            if (i == 8) config.launchProtection = true;
            if (i == 9) config.tickLower++;
            if (i == 10) config.sqrtPriceX96++;
            if (i == 11) config.liquidity--;
            if (i == 12) config.liquidity++;
            vm.expectRevert();
            standardFactory.launch(config, hookSalt);
        }
    }

    function testWrongPriceEvenWithValidRangeAndLiquidityRejected() public {
        _standard(false);
        config.tickUpper += 500;
        config.sqrtPriceX96 = TickMath.getSqrtPriceAtTick(config.tickUpper);
        (config.liquidity,,) = standardFactory.quoter()
            .previewLiquidity(config.sqrtPriceX96, config.tickLower, config.tickUpper, 0, config.maxToken);
        vm.expectRevert(M.ReferencePriceMoved.selector);
        standardFactory.launch(config, hookSalt);
    }

    function testPriceDriftAfterQuoteRejectsLaunchWithoutPartialContracts() public {
        _standard(false);
        (, T.Market memory predicted,) = standardFactory.predictLaunch(address(this), config, hookSalt);
        VeylSwapRouter(payable(mainMarket.swapRouter)).buy{value: 5 ether}(
            5 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp
        );
        vm.expectRevert(M.ReferencePriceMoved.selector);
        standardFactory.launch(config, hookSalt);
        _assertAbsent(predicted);
    }

    function testCreatorBuySlippageMissingAllowanceAndPartialFillRollbackEverything() public {
        _standard(false);
        (, T.Market memory predicted,) = standardFactory.predictLaunch(address(this), config, hookSalt);
        (uint256 expected,,) = standardFactory.previewInitialBuy(address(this), config, 0.05 ether, _limit(false, true));
        vm.expectRevert();
        standardFactory.launchAndBuy(config, hookSalt, 0.05 ether, expected, _limit(false, true));
        _assertAbsent(predicted);
        IERC20(mainMarket.token).approve(address(standardFactory), 0.05 ether);
        vm.expectRevert(VeylAgentLaunchFactory.IncorrectFunding.selector);
        standardFactory.launchAndBuy(config, hookSalt, 0.05 ether, expected + 1, _limit(false, true));
        _assertAbsent(predicted);
        vm.expectRevert();
        standardFactory.launchAndBuy(config, hookSalt, 0.05 ether, 1, config.sqrtPriceX96 - 1);
        _assertAbsent(predicted);
        assertEq(IERC20(mainMarket.token).allowance(address(this), address(standardFactory)), 0.05 ether);
    }

    function testZeroBuyPreviewValidatesSavedConfigAndDoesNotCreateState() public {
        _standard(true);
        (uint256 out, uint256 fee, uint160 price) =
            standardFactory.previewInitialBuy(address(this), config, 0, _limit(true, true));
        assertEq(out, 0);
        assertEq(fee, 0);
        assertEq(price, config.sqrtPriceX96);
        assertEq(standardFactory.getMarket(standardFactory.marketId(address(this), config.salt)).token, address(0));
        config.buyFeeBps = 0;
        vm.expectRevert(M.InvalidLaunchTerms.selector);
        standardFactory.previewInitialBuy(address(this), config, 0, _limit(true, true));
    }

    function testUnexpectedETHAndExpiredDeadlineRejected() public {
        _standard(true);
        vm.expectRevert(VeylAgentLaunchFactory.IncorrectFunding.selector);
        standardFactory.launch{value: 1}(config, hookSalt);
        vm.warp(config.deadline + 1);
        vm.expectRevert(VeylAgentLaunchFactory.Expired.selector);
        standardFactory.launch(config, hookSalt);
    }

    function testWrongReferenceTokenAndRouterConstructorRejected() public {
        VeylQuoter q = factory.quoter();
        vm.expectRevert(VeylAgentLaunchFactory.InvalidConfiguration.selector);
        new VeylAgentLaunchFactory(
            manager, PLATFORM, q, address(0), mainMarket.swapRouter, projectBuilder, marketBuilder, liquidityBuilder
        );
        vm.expectRevert(VeylAgentLaunchFactory.InvalidConfiguration.selector);
        new VeylAgentLaunchFactory(
            manager,
            PLATFORM,
            q,
            mainMarket.treasury,
            mainMarket.swapRouter,
            projectBuilder,
            marketBuilder,
            liquidityBuilder
        );
    }

    function testDonatedQuoteCannotBeTakenByCreatorBuy() public {
        IERC20(mainMarket.token).transfer(address(standardFactory), 7 ether);
        _roundTrip(false, 0.05 ether);
        assertEq(IERC20(mainMarket.token).balanceOf(address(standardFactory)), 7 ether);
    }

    function testWrongHookPermissionsRevertAllDeploymentAndAllocation() public {
        _standard(true);
        bytes32 wrong = bytes32(uint256(hookSalt) + 1);
        (, T.Market memory predicted,) = standardFactory.predictLaunch(address(this), config, wrong);
        if (uint160(predicted.hook) & 0x3fff == 0x20cc) return;
        vm.expectRevert();
        standardFactory.launch(config, wrong);
        _assertAbsent(predicted);
    }

    function testHelperPreservesOnlyIdentityAndTreasuryControls() public {
        _standard(true);
        T.LaunchConfig memory input = config;
        input.buyFeeBps = 9999;
        input.sellFeeBps = 9999;
        input.launchProtection = true;
        input.maxToken = 1;
        input.maxQuote = 999 ether;
        input.minQuote = 999 ether;
        input.lpFeePips = 999;
        input.tickSpacing = 200;
        input.treasuryOwner = address(0xABC);
        input.operator = address(0xDEF);
        input.dailyLimit = 0.1 ether;
        input.treasuryEth = 0.2 ether;
        (T.LaunchConfig memory derived,,,,) = standardFactory.standardLaunchConfig(address(this), input);
        assertEq(derived.treasuryOwner, input.treasuryOwner);
        assertEq(derived.operator, input.operator);
        assertEq(derived.dailyLimit, input.dailyLimit);
        assertEq(derived.treasuryEth, input.treasuryEth);
        assertEq(derived.salt, input.salt);
        assertEq(derived.name, input.name);
        assertEq(derived.symbol, input.symbol);
        assertEq(derived.deadline, input.deadline);
        assertEq(derived.buyFeeBps, 180);
        assertEq(derived.sellFeeBps, 180);
        assertFalse(derived.launchProtection);
        assertEq(derived.maxToken, 1_000_000_000 ether);
        assertEq(derived.maxQuote, 0);
        assertEq(derived.minQuote, 0);
        assertEq(derived.lpFeePips, 0);
        assertEq(derived.tickSpacing, 1);
    }

    function testFuzzStandardPriceAndMaximalLiquidityAcrossReferenceRange(int24 tickRaw, bool token0) public view {
        int24 refTick = int24(bound(int256(tickRaw), -30_000, 250_000));
        uint160 referencePrice = TickMath.getSqrtPriceAtTick(refTick);
        (T.LaunchConfig memory derived, uint256 used) = M.standard(config, token0, referencePrice, factory.quoter());
        assertLe(used, 1_000_000_000 ether);
        assertLe(1_000_000_000 ether - used, 1_000_000);
        assertGt(M.seedCost(derived, token0, factory.quoter(), derived.liquidity + 1), 1_000_000_000 ether);
        uint256 fdv = M.startingFdv(derived, token0, referencePrice);
        assertGe(fdv, 19998e14);
        assertLe(fdv, 20002e14);
        assertEq(derived.maxQuote, 0);
    }

    function testFuzzInitialBuyMatchesRealPoolBothOrders(uint96 rawAmount, bool token0) public {
        uint256 amount = bound(uint256(rawAmount), 1e12, 2 ether);
        _paidLaunch(token0, amount);
    }
}

contract VeylAgentLaunchFactoryForkTest is StandardAgentFixture {
    function testCanonicalMainnetBuildersReferenceLaunchBuySellAndETHFeeConversion() public {
        vm.skip(!vm.envOr("VEYL_STANDARD_FORK", false));
        string memory rpc = vm.envOr("ETHEREUM_RPC_URL", string("https://ethereum-rpc.publicnode.com"));
        uint256 pinned = vm.envOr("VEYL_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);
        emit log_named_uint("Canonical mainnet fork block", block.number);
        manager = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
        factory = VeylMarketFactory(0xDca5aa52402Bd413B1604b5468C672Dc2BCcBa73);
        projectBuilder = factory.projectBuilder();
        marketBuilder = factory.marketBuilder();
        liquidityBuilder = VeylMarketFactory(0xFA3b25E3Aa962DC08439E4Fb4c0D65c0EBcD702E).liquidityBuilder();
        mainMarket.token = 0x2eaB833d244352D4A7f8dC93285B1776F01954cB;
        mainMarket.swapRouter = 0xA847BE733c61a994a4D565DE41fE07528Be3cc68;
        mainMarket.hook = 0xf0c906814F9a1a8Eb26756e03B150E3AAf8920CC;
        config.treasuryOwner = address(this);
        _newFactory();
        vm.deal(address(this), 1 ether);
        uint256 acquired = VeylSwapRouter(payable(mainMarket.swapRouter)).buy{value: 0.0001 ether}(
            0.0001 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp
        );
        assertGt(acquired, 0);
        _roundTrip(false, acquired / 4);
        _roundTrip(true, acquired / 4);
    }
}
