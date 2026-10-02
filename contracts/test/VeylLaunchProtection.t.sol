// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VeylMarketFixture} from "./VeylMarketFactory.t.sol";
import {AgentToken} from "../src/AgentKit.sol";
import {VeylMarketTypes as T} from "../src/market/VeylMarketTypes.sol";
import {VeylMarketFactory} from "../src/market/VeylMarketFactory.sol";
import {VeylQuoter} from "../src/market/VeylQuoter.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolClaimsTest} from "v4-core/src/test/PoolClaimsTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract VeylLaunchProtectionTest is VeylMarketFixture {
    uint256 constant LIMIT = 20_000_000 ether;
    address constant TRADER = address(0xB0B);
    address constant OTHER = address(0xBEEF);

    function setUp() public {
        _configure(IPoolManager(address(new PoolManager(address(this)))));
        vm.deal(address(this), 10_000 ether);
        vm.deal(TRADER, 100 ether);
    }

    function _guardedConfig(uint256 targetSeed) internal {
        config.launchProtection = true;
        config.treasuryEth = 0;
        config.maxQuote = 0;
        config.minQuote = 0;
        config.maxToken = 1_000_000_000 ether;
        config.minToken = targetSeed - 1 ether;
        config.sqrtPriceX96 = uint160(uint256(79228162514264337593543950336) * 100000);
        config.tickLower = 220000;
        config.tickUpper = 230000;
        (config.liquidity,,) =
            factory.quoter().previewLiquidity(config.sqrtPriceX96, config.tickLower, config.tickUpper, 0, targetSeed);
        hookSalt = _mine(address(this), config);
    }

    function _guardedLaunch() internal returns (T.Market memory market, AgentToken token) {
        _guardedConfig(990_000_000 ether);
        market = _launch();
        token = AgentToken(market.token);
    }

    function testGuardedLaunchSeedsBeforeActivationAndCapsActualCreatorRefund() public {
        (T.Market memory market, AgentToken token) = _guardedLaunch();
        assertTrue(token.launchProtectionEnabled());
        assertTrue(token.activated());
        assertEq(token.launchFactory(), address(factory));
        assertEq(token.poolManager(), address(manager));
        assertEq(token.bootstrapVault(), market.liquidityVault);
        assertEq(token.launchBlock(), block.number);
        assertTrue(token.launchLimitsActive());
        assertLe(token.balanceOf(address(this)), LIMIT);
        assertGe(token.balanceOf(address(manager)), 980_000_000 ether);
        assertEq(token.balanceOf(address(factory)) + token.balanceOf(market.liquidityVault), 0);
        assertEq(token.balanceOf(address(manager)) + token.balanceOf(address(this)), token.totalSupply());
    }

    function testCreatorExcessIncludingUnusedSeedRefundRevertsEntireLaunch() public {
        _guardedConfig(970_000_000 ether); // maxToken is 1B, but actual locked seed is under 98%.
        (bytes32 id, T.Market memory predicted,) = factory.predictLaunch(address(this), config, hookSalt);
        vm.expectRevert(AgentToken.CreatorAllocationTooLarge.selector);
        _launch();
        _assertAbsent(predicted);
        assertEq(factory.getMarket(id).token, address(0));
    }

    function testTenExactBlocksAndNoPoolManagerSenderExemption() public {
        (, AgentToken token) = _guardedLaunch();
        uint256 start = block.number;
        for (uint256 i; i < 10; ++i) {
            vm.roll(start + i);
            assertTrue(token.launchLimitsActive());
            vm.expectRevert(AgentToken.MaxTransactionExceeded.selector);
            vm.prank(address(manager));
            token.transfer(TRADER, LIMIT + 1);
        }
        vm.roll(start + 10);
        assertFalse(token.launchLimitsActive());
        vm.prank(address(manager));
        token.transfer(TRADER, LIMIT * 2);
        assertEq(token.balanceOf(TRADER), LIMIT * 2);
    }

    function testOrdinaryTransfersAndTransferFromRespectWalletCap() public {
        (, AgentToken token) = _guardedLaunch();
        vm.prank(address(manager));
        token.transfer(TRADER, LIMIT);
        vm.expectRevert(AgentToken.MaxWalletExceeded.selector);
        token.transfer(TRADER, 1);
        vm.prank(TRADER);
        token.approve(OTHER, type(uint256).max);
        vm.prank(OTHER);
        token.transferFrom(TRADER, OTHER, LIMIT);
        vm.expectRevert(AgentToken.MaxWalletExceeded.selector);
        token.transfer(OTHER, 1);
        vm.expectRevert(AgentToken.MaxTransactionExceeded.selector);
        vm.prank(OTHER);
        token.transfer(address(manager), LIMIT + 1);
        vm.prank(OTHER);
        token.transfer(address(manager), LIMIT);
        assertEq(token.balanceOf(OTHER), 0);
    }

    function testRealDEXBuyCannotBypassTransactionOrWalletCap() public {
        (T.Market memory market, AgentToken token) = _guardedLaunch();
        VeylSwapRouter swapper = VeylSwapRouter(payable(market.swapRouter));
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        VeylQuoter.Quote memory large =
            factory.quoter().quoteExactInput(hook, true, 0.01 ether, TickMath.MIN_SQRT_PRICE + 1);
        assertGt(large.amountOut, LIMIT);
        vm.expectRevert();
        vm.prank(TRADER);
        swapper.buy{value: 0.01 ether}(0.01 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        vm.prank(TRADER);
        uint256 bought = swapper.buy{value: 0.0001 ether}(0.0001 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        assertGt(bought, 0);
        assertLt(bought, LIMIT);
        vm.prank(address(manager));
        token.transfer(TRADER, LIMIT - bought);
        vm.expectRevert();
        vm.prank(TRADER);
        swapper.buy{value: 0.0001 ether}(0.0001 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        assertEq(token.balanceOf(TRADER), LIMIT);
        // Other capped buyers provide enough ETH depth that an oversized sell
        // would actually settle over 20M tokens, rather than partially fill.
        for (uint256 i; i < 2; ++i) {
            address buyer = address(uint160(0x1000 + i));
            vm.deal(buyer, 1 ether);
            vm.prank(buyer);
            swapper.buy{value: 0.0015 ether}(0.0015 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        }
        vm.prank(TRADER);
        token.approve(address(swapper), type(uint256).max);
        vm.prank(TRADER);
        (uint256 sold,) = swapper.sell(1 ether, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
        assertEq(sold, 1 ether);
        vm.expectRevert();
        vm.prank(TRADER);
        swapper.sell(LIMIT + 1, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
    }

    function testCreatorAndFactoryCannotReactivateOrWhitelistAfterLaunch() public {
        (, AgentToken token) = _guardedLaunch();
        vm.expectRevert(AgentToken.NotLaunchFactory.selector);
        token.activate();
        vm.expectRevert(AgentToken.AlreadyActivated.selector);
        vm.prank(address(factory));
        token.activate();
        vm.expectRevert(AgentToken.InvalidBootstrap.selector);
        vm.prank(address(factory));
        token.setBootstrapVault(OTHER);
        (bool ok,) = address(token).call(abi.encodeWithSignature("setWhitelist(address,bool)", TRADER, true));
        assertFalse(ok);
    }

    function testGenericAgentLaunchStillHasNoCaps() public {
        T.Market memory market = _launch();
        AgentToken token = AgentToken(market.token);
        assertFalse(token.launchProtectionEnabled());
        assertFalse(token.launchLimitsActive());
        token.transfer(TRADER, LIMIT * 2);
        assertEq(token.balanceOf(TRADER), LIMIT * 2);
    }

    function testFactoryRejectsMissingAndForeignPoolQuoter() public {
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        new VeylMarketFactory(
            manager,
            PLATFORM,
            VeylQuoter(address(0)),
            address(0),
            address(0),
            projectBuilder,
            marketBuilder,
            liquidityBuilder
        );
        VeylQuoter wrong = new VeylQuoter(IPoolManager(address(new PoolManager(address(this)))));
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        new VeylMarketFactory(
            manager, PLATFORM, wrong, address(0), address(0), projectBuilder, marketBuilder, liquidityBuilder
        );
    }

    function testSeedETHRefundCallbackCannotBuyBeforeActivation() public {
        _guardedConfig(990_000_000 ether);
        config.maxQuote = 1 ether;
        BootstrapBuyer receiver = new BootstrapBuyer(factory);
        bytes32 salt = _mine(address(receiver), config);
        (, T.Market memory predicted,) = factory.predictLaunch(address(receiver), config, salt);
        T.Market memory market = receiver.launch{value: 1 ether}(config, salt, predicted.swapRouter);
        assertTrue(receiver.attempted());
        assertFalse(receiver.boughtDuringBootstrap());
        assertFalse(receiver.claimedDuringBootstrap());
        AgentToken token = AgentToken(market.token);
        assertTrue(token.activated());
        assertLe(token.balanceOf(address(receiver)), LIMIT);
    }

    function testExternalV4RouterERC20BuysAndSellsWorkThroughoutProtectedWindow() public {
        (T.Market memory market, AgentToken token) = _guardedLaunch();
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        PoolSwapTest externalRouter = new PoolSwapTest(manager);
        PoolKey memory key = hook.getPoolKey();
        uint256 launch = token.launchBlock();
        VeylQuoter.Quote memory large =
            factory.quoter().quoteExactInput(hook, true, 0.01 ether, TickMath.MIN_SQRT_PRICE + 1);
        assertGt(large.amountOut, LIMIT);
        vm.expectRevert();
        vm.prank(TRADER);
        externalRouter.swap{value: 0.01 ether}(
            key,
            SwapParams(true, -int256(0.01 ether), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(token.balanceOf(TRADER), 0);
        vm.prank(TRADER);
        token.approve(address(externalRouter), type(uint256).max);
        for (uint256 i; i < 10; ++i) {
            vm.roll(launch + i);
            assertTrue(token.launchLimitsActive());
            uint256 before = token.balanceOf(TRADER);
            vm.prank(TRADER);
            externalRouter.swap{value: 0.0001 ether}(
                key,
                SwapParams(true, -int256(0.0001 ether), TickMath.MIN_SQRT_PRICE + 1),
                PoolSwapTest.TestSettings(false, false),
                ""
            );
            uint256 afterBuy = token.balanceOf(TRADER);
            assertGt(afterBuy, before);
            assertLe(afterBuy, LIMIT);
            vm.prank(TRADER);
            externalRouter.swap(
                key,
                SwapParams(false, -int256(1 ether), TickMath.MAX_SQRT_PRICE - 1),
                PoolSwapTest.TestSettings(false, false),
                ""
            );
            assertEq(token.balanceOf(TRADER), afterBuy - 1 ether);
        }
        VeylQuoter.Quote memory walletOverflow =
            factory.quoter().quoteExactInput(hook, true, 0.0015 ether, TickMath.MIN_SQRT_PRICE + 1);
        assertLt(walletOverflow.amountOut, LIMIT);
        assertGt(token.balanceOf(TRADER) + walletOverflow.amountOut, LIMIT);
        vm.expectRevert();
        vm.prank(TRADER);
        externalRouter.swap{value: 0.0015 ether}(
            key,
            SwapParams(true, -int256(0.0015 ether), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        vm.roll(launch + 10);
        vm.prank(TRADER);
        externalRouter.swap{value: 0.01 ether}(
            key,
            SwapParams(true, -int256(0.01 ether), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertGt(token.balanceOf(TRADER), LIMIT);
    }

    function testExternalClaimSettlementAllowedButERC20RedemptionStillCapped() public {
        (T.Market memory market, AgentToken token) = _guardedLaunch();
        PoolSwapTest externalRouter = new PoolSwapTest(manager);
        PoolClaimsTest claimRouter = new PoolClaimsTest(manager);
        PoolKey memory key = VeylFeeHook(payable(market.hook)).getPoolKey();
        uint256 claimId = uint256(uint160(market.token));
        vm.prank(TRADER);
        externalRouter.swap{value: 0.01 ether}(
            key,
            SwapParams(true, -int256(0.01 ether), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(true, false),
            ""
        );
        uint256 claims = manager.balanceOf(TRADER, claimId);
        assertGt(claims, LIMIT * 3);
        assertEq(token.balanceOf(TRADER), 0);
        assertTrue(token.launchLimitsActive());
        vm.prank(TRADER);
        manager.approve(address(externalRouter), claimId, type(uint256).max);
        vm.prank(TRADER);
        externalRouter.swap(
            key,
            SwapParams(false, -int256(LIMIT + 1), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, true),
            ""
        );
        assertEq(manager.balanceOf(TRADER, claimId), claims - LIMIT - 1);
        assertEq(token.balanceOf(TRADER), 0);
        vm.prank(TRADER);
        manager.approve(address(claimRouter), claimId, type(uint256).max);
        vm.expectRevert();
        vm.prank(TRADER);
        claimRouter.withdraw(Currency.wrap(market.token), TRADER, LIMIT + 1);
        assertEq(manager.balanceOf(TRADER, claimId), claims - LIMIT - 1);
        vm.prank(TRADER);
        claimRouter.withdraw(Currency.wrap(market.token), TRADER, LIMIT);
        assertEq(token.balanceOf(TRADER), LIMIT);
        vm.roll(token.launchBlock() + 9);
        vm.expectRevert();
        vm.prank(TRADER);
        claimRouter.withdraw(Currency.wrap(market.token), TRADER, 1);
        uint256 remaining = manager.balanceOf(TRADER, claimId);
        assertGt(remaining, LIMIT);
        vm.roll(token.launchBlock() + 10);
        vm.prank(TRADER);
        claimRouter.withdraw(Currency.wrap(market.token), TRADER, remaining);
        assertEq(manager.balanceOf(TRADER, claimId), 0);
        assertGt(token.balanceOf(TRADER), LIMIT);
    }
}

contract BootstrapBuyer {
    VeylMarketFactory immutable factory;
    PoolSwapTest immutable externalRouter;
    VeylSwapRouter private swapper;
    bool public attempted;
    bool public boughtDuringBootstrap;
    bool public claimedDuringBootstrap;

    constructor(VeylMarketFactory factory_) {
        factory = factory_;
        externalRouter = new PoolSwapTest(factory_.poolManager());
    }

    function launch(T.LaunchConfig calldata config, bytes32 salt, address predictedSwapper)
        external
        payable
        returns (T.Market memory market)
    {
        swapper = VeylSwapRouter(payable(predictedSwapper));
        (, market) = factory.launch{value: msg.value}(config, salt);
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        try swapper.buy{value: 0.0001 ether}(0.0001 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp) returns (
            uint256
        ) {
            boughtDuringBootstrap = true;
        } catch {}
        try externalRouter.swap{value: 0.0001 ether}(
            swapper.hook().getPoolKey(),
            SwapParams(true, -int256(0.0001 ether), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(true, false),
            ""
        ) {
            claimedDuringBootstrap = true;
        } catch {}
    }
}
