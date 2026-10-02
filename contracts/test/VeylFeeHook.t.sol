// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {RevenueRouter} from "../src/Funding.sol";
import {AgentToken} from "../src/AgentKit.sol";

contract VeylFeeHookTest is Test {
    // Fixture rates exercise the implementation only; no mainnet rates are selected here.
    uint16 constant BUY = 250;
    uint16 constant SELL = 375;
    uint24 constant LP_FEE = 3000;
    int24 constant SPACING = 60;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    uint160 constant PRICE = 79228162514264337593543950336;
    PoolManager manager;
    AgentToken token;
    RevenueRouter router;
    VeylFeeHook hook;
    PoolSwapTest swapper;
    PoolModifyLiquidityTest liquidity;
    PoolKey key;
    address trader = address(0xB0B);
    address treasury = address(0x111);
    address creator = address(0x222);
    address platform = address(0x333);

    function setUp() public {
        manager = new PoolManager(address(this));
        token = new AgentToken("Test agent", "TEST", address(this), false, address(0));
        router = new RevenueRouter(treasury, creator, platform);
        swapper = new PoolSwapTest(manager);
        liquidity = new PoolModifyLiquidityTest(manager);
        hook = _deployHook(1000, BUY, SELL, router);
        key = hook.getPoolKey();
        manager.initialize(key, PRICE);
        vm.deal(address(this), 10_000 ether);
        vm.deal(trader, 100 ether);
        token.approve(address(liquidity), type(uint256).max);
        token.transfer(trader, 1000 ether);
        vm.prank(trader);
        token.approve(address(swapper), type(uint256).max);
        _seed(key, -600, 600);
    }

    function _deployHook(uint160 namespace, uint16 buy, uint16 sell, RevenueRouter target)
        internal
        returns (VeylFeeHook result)
    {
        address location = address((namespace << 14) | FLAGS);
        deployCodeTo(
            "VeylFeeHook.sol:VeylFeeHook",
            abi.encode(manager, address(token), target, address(this), buy, sell, LP_FEE, SPACING, address(0)),
            location
        );
        result = VeylFeeHook(payable(location));
    }

    function _seed(PoolKey memory target, int24 lower, int24 upper) internal {
        liquidity.modifyLiquidity{value: 1000 ether}(
            target,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: 10_000 ether, salt: bytes32(0)}),
            ""
        );
    }

    function _swap(PoolKey memory target, bool buy, int256 amount, uint160 limit) internal returns (BalanceDelta) {
        vm.prank(trader);
        return swapper.swap{value: buy ? 20 ether : 0}(
            target,
            SwapParams({zeroForOne: buy, amountSpecified: amount, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _trade(bool buy, int256 amount) internal returns (BalanceDelta) {
        return _swap(key, buy, amount, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function _hookError(VeylFeeHook subject, bytes4 callback, bytes4 reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(subject),
            callback,
            abi.encodeWithSelector(reason),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function testExactInputBuyReservesETHClaimsAndConservesInput() public {
        uint256 beforeTrader = trader.balance;
        uint256 beforeManager = address(manager).balance;
        BalanceDelta delta = _trade(true, -int256(1 ether));
        assertEq(-int256(delta.amount0()), 1 ether);
        assertGt(delta.amount1(), 0);
        assertEq(beforeTrader - trader.balance, 1 ether);
        assertEq(address(manager).balance - beforeManager, 1 ether);
        assertEq(hook.pendingFees(), 1 ether * uint256(BUY) / 10_000);
        assertEq(address(hook).balance, 0);
        assertEq(address(router).balance, 0);
    }

    function testExactInputSellChargesActualETHOutput() public {
        uint256 beforeManager = address(manager).balance;
        uint256 beforeTrader = trader.balance;
        BalanceDelta delta = _trade(false, -int256(1 ether));
        uint256 fee = hook.pendingFees();
        uint256 net = uint256(uint128(delta.amount0()));
        assertEq(-int256(delta.amount1()), 1 ether);
        assertEq(trader.balance - beforeTrader, net);
        assertEq(beforeManager - address(manager).balance, net);
        assertEq(fee, (net + fee) * SELL / 10_000);
        assertGt(fee, 0);
    }

    function testExactOutputBuyGrossesUpActualETHInput() public {
        uint256 beforeTrader = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        BalanceDelta delta = _trade(true, int256(1 ether));
        uint256 gross = uint256(-int256(delta.amount0()));
        uint256 fee = hook.pendingFees();
        assertEq(token.balanceOf(trader) - beforeToken, 1 ether);
        assertEq(beforeTrader - trader.balance, gross);
        assertEq(fee, ((gross - fee) * BUY + (10_000 - BUY) - 1) / (10_000 - BUY));
    }

    function testExactOutputSellDeliversRequestedETHNetOfFee() public {
        uint256 beforeTrader = trader.balance;
        BalanceDelta delta = _trade(false, int256(1 ether));
        assertEq(delta.amount0(), 1 ether);
        assertEq(trader.balance - beforeTrader, 1 ether);
        assertEq(hook.pendingFees(), (1 ether * uint256(SELL) + (10_000 - SELL) - 1) / (10_000 - SELL));
        assertLt(delta.amount1(), 0);
    }

    function testPermissionlessFlushAllocatesEveryWeiAndCannotRepeat() public {
        _trade(true, -int256(1 ether));
        _trade(false, -int256(1 ether));
        uint256 owed = hook.pendingFees();
        uint256 beforeManager = address(manager).balance;
        vm.prank(address(0xF00));
        assertEq(hook.flushFees(), owed);
        assertEq(hook.pendingFees(), 0);
        assertEq(address(hook).balance, 0);
        assertEq(beforeManager - address(manager).balance, owed);
        assertEq(address(router).balance, owed);
        assertEq(router.claimable(treasury), owed * 7 / 10);
        assertEq(router.claimable(creator), owed / 5);
        assertEq(router.claimable(platform), owed - owed * 7 / 10 - owed / 5);
        assertEq(hook.flushFees(), 0);
        router.distribute(payable(treasury));
        router.distribute(payable(creator));
        router.distribute(payable(platform));
        assertEq(treasury.balance + creator.balance + platform.balance, owed);
        assertEq(address(router).balance, 0);
    }

    function testUnsettledInitialBuyWorksWhenManagerStartsWithNoETH() public {
        // Replace the manager so prior fixture liquidity cannot supply ETH to the callback.
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(manager);
        liquidity = new PoolModifyLiquidityTest(manager);
        token.approve(address(liquidity), type(uint256).max);
        vm.prank(trader);
        token.approve(address(swapper), type(uint256).max);
        hook = _deployHook(2000, BUY, SELL, router);
        key = hook.getPoolKey();
        manager.initialize(key, PRICE);
        _seed(key, -600, -60);
        assertEq(address(manager).balance, 0);
        _trade(true, -int256(1 ether));
        assertEq(address(manager).balance, 1 ether);
        assertEq(hook.pendingFees(), 1 ether * uint256(BUY) / 10_000);
        hook.flushFees();
        assertEq(address(router).balance, 1 ether * uint256(BUY) / 10_000);
    }

    function testSpecifiedETHPartialFillsRevertWithoutLeakingClaims() public {
        uint256 beforeTrader = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        vm.expectRevert(_hookError(hook, IHooks.afterSwap.selector, VeylFeeHook.PartialFillUnsupported.selector));
        _swap(key, true, -int256(10 ether), TickMath.getSqrtPriceAtTick(-1));
        assertEq(hook.pendingFees(), 0);
        assertEq(trader.balance, beforeTrader);
        assertEq(token.balanceOf(trader), beforeToken);
        vm.expectRevert(_hookError(hook, IHooks.afterSwap.selector, VeylFeeHook.PartialFillUnsupported.selector));
        _swap(key, false, int256(10 ether), TickMath.getSqrtPriceAtTick(1));
        assertEq(hook.pendingFees(), 0);
        assertEq(trader.balance, beforeTrader);
        assertEq(token.balanceOf(trader), beforeToken);
    }

    function testUnspecifiedETHPartialSellChargesOnlyFilledOutput() public {
        BalanceDelta delta = _swap(key, false, -int256(10 ether), TickMath.getSqrtPriceAtTick(1));
        assertLt(uint256(-int256(delta.amount1())), 10 ether);
        uint256 net = uint256(uint128(delta.amount0()));
        uint256 fee = hook.pendingFees();
        assertEq(fee, (net + fee) * SELL / 10_000);
        assertGt(fee, 0);
    }

    function testUnspecifiedETHPartialBuyChargesOnlyFilledInput() public {
        uint256 beforeTrader = trader.balance;
        BalanceDelta delta = _swap(key, true, int256(10 ether), TickMath.getSqrtPriceAtTick(-1));
        assertLt(uint256(uint128(delta.amount1())), 10 ether);
        uint256 gross = uint256(-int256(delta.amount0()));
        uint256 fee = hook.pendingFees();
        assertEq(beforeTrader - trader.balance, gross);
        assertEq(fee, ((gross - fee) * BUY + (10_000 - BUY) - 1) / (10_000 - BUY));
    }

    function testForeignPoolConfigurationAndUnauthorizedInitializationRejected() public {
        VeylFeeHook fresh = _deployHook(3000, BUY, SELL, router);
        PoolKey memory target = fresh.getPoolKey();
        vm.expectRevert(_hookError(fresh, IHooks.beforeInitialize.selector, VeylFeeHook.NotInitializer.selector));
        vm.prank(trader);
        manager.initialize(target, PRICE);
        assertFalse(fresh.poolInitialized());
        PoolKey memory foreign = target;
        foreign.fee = 500;
        vm.expectRevert(_hookError(fresh, IHooks.beforeInitialize.selector, VeylFeeHook.WrongPool.selector));
        manager.initialize(foreign, PRICE);
        target = fresh.getPoolKey();
        foreign = target;
        foreign.tickSpacing = 10;
        vm.expectRevert(_hookError(fresh, IHooks.beforeInitialize.selector, VeylFeeHook.WrongPool.selector));
        manager.initialize(foreign, PRICE);
        target = fresh.getPoolKey();
        foreign = target;
        foreign.currency1 = Currency.wrap(address(new AgentToken("Other", "OTHER", address(this), false, address(0))));
        vm.expectRevert(_hookError(fresh, IHooks.beforeInitialize.selector, VeylFeeHook.WrongPool.selector));
        manager.initialize(foreign, PRICE);
        target = fresh.getPoolKey();
        foreign = target;
        foreign.currency0 = Currency.wrap(address(1));
        vm.expectRevert(_hookError(fresh, IHooks.beforeInitialize.selector, VeylFeeHook.WrongPool.selector));
        manager.initialize(foreign, PRICE);
        assertFalse(fresh.poolInitialized());
    }

    function testCallbacksRejectNonManagerAndUnsolicitedRedemption() public {
        SwapParams memory params = SwapParams(true, -int256(1 ether), TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(VeylFeeHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, params, "");
        vm.expectRevert(VeylFeeHook.NotPoolManager.selector);
        hook.unlockCallback("");
        vm.expectRevert(VeylFeeHook.NoRedemption.selector);
        vm.prank(address(manager));
        hook.unlockCallback("");
        (bool ok,) = address(hook).call{value: 1}("");
        assertFalse(ok);
    }

    function testNestedFlushDuringManagerUnlockCannotConsumeFees() public {
        _trade(true, -int256(1 ether));
        uint256 owed = hook.pendingFees();
        NestedFlush attempt = new NestedFlush(manager, hook);
        attempt.attempt();
        assertFalse(attempt.succeeded());
        assertEq(hook.pendingFees(), owed);
        assertEq(address(router).balance, 0);
        assertEq(hook.flushFees(), owed);
    }

    function testRejectingBeneficiaryCannotBlockFeeFlush() public {
        RejectRevenue rejector = new RejectRevenue();
        RevenueRouter receiver = new RevenueRouter(treasury, address(rejector), platform);
        VeylFeeHook other = _deployHook(4000, BUY, SELL, receiver);
        PoolKey memory target = other.getPoolKey();
        manager.initialize(target, PRICE);
        _seed(target, -600, 600);
        _swap(target, true, -int256(1 ether), TickMath.MIN_SQRT_PRICE + 1);
        uint256 owed = other.pendingFees();
        other.flushFees();
        vm.expectRevert("transfer failed");
        receiver.distribute(payable(address(rejector)));
        receiver.distribute(payable(treasury));
        receiver.distribute(payable(platform));
        assertEq(receiver.claimable(address(rejector)), owed / 5);
        assertEq(address(receiver).balance, owed / 5);
    }

    function testFuzzBuyFeeRoundingAndFlushConservation(uint96 input) public {
        uint256 amount = bound(input, 100, 1 ether);
        _trade(true, -int256(amount));
        uint256 owed = amount * BUY / 10_000;
        assertEq(hook.pendingFees(), owed);
        hook.flushFees();
        assertEq(router.claimable(treasury) + router.claimable(creator) + router.claimable(platform), owed);
        assertEq(hook.pendingFees(), 0);
    }

    function testZeroRatesAccrueNothing() public {
        VeylFeeHook free = _deployHook(5000, 0, 0, router);
        PoolKey memory target = free.getPoolKey();
        manager.initialize(target, PRICE);
        _seed(target, -600, 600);
        _swap(target, true, -int256(1 ether), TickMath.MIN_SQRT_PRICE + 1);
        _swap(target, false, -int256(1 ether), TickMath.MAX_SQRT_PRICE - 1);
        assertEq(free.pendingFees(), 0);
        assertEq(free.flushFees(), 0);
    }

    function testFuzzExactOutputSellRateAndRounding(uint16 rateInput) public {
        uint16 rate = uint16(bound(rateInput, 0, 9999));
        VeylFeeHook variableRate = _deployHook(6000, 0, rate, router);
        PoolKey memory target = variableRate.getPoolKey();
        manager.initialize(target, PRICE);
        _seed(target, -600, 600);
        uint256 beforeTrader = trader.balance;
        uint256 output = 0.001 ether;
        _swap(target, false, int256(output), TickMath.MAX_SQRT_PRICE - 1);
        assertEq(trader.balance - beforeTrader, output);
        assertEq(variableRate.pendingFees(), (output * rate + (10_000 - rate) - 1) / (10_000 - rate));
        assertEq(variableRate.sellFeeBps(), rate);
        uint256 owed = variableRate.pendingFees();
        variableRate.flushFees();
        assertEq(address(router).balance, owed);
    }

    function testOversizedSpecifiedAmountIsRejectedBeforeMinting() public {
        vm.expectRevert(_hookError(hook, IHooks.beforeSwap.selector, VeylFeeHook.SwapTooLarge.selector));
        _trade(true, int256(type(int128).max) + 1);
        assertEq(hook.pendingFees(), 0);
    }

    function testConstructorRejectsInvalidInputs() public {
        vm.expectRevert(VeylFeeHook.InvalidConfiguration.selector);
        new VeylFeeHook(manager, address(token), router, address(this), 10_000, SELL, LP_FEE, SPACING, address(0));
        vm.expectRevert(VeylFeeHook.InvalidConfiguration.selector);
        new VeylFeeHook(manager, address(token), router, address(0), BUY, SELL, LP_FEE, SPACING, address(0));
        vm.expectRevert(VeylFeeHook.InvalidConfiguration.selector);
        new VeylFeeHook(
            IPoolManager(address(0)), address(token), router, address(this), BUY, SELL, LP_FEE, SPACING, address(0)
        );
        vm.expectRevert(VeylFeeHook.InvalidConfiguration.selector);
        new VeylFeeHook(manager, address(0), router, address(this), BUY, SELL, LP_FEE, SPACING, address(0));
        vm.expectRevert(VeylFeeHook.InvalidConfiguration.selector);
        new VeylFeeHook(manager, address(token), router, address(this), BUY, SELL, 0x800000, SPACING, address(0));
        vm.expectRevert(VeylFeeHook.InvalidConfiguration.selector);
        new VeylFeeHook(manager, address(token), router, address(this), BUY, SELL, LP_FEE, 0, address(0));
    }

    function testMinedCreate2DeploymentEnforcesPermissions() public {
        bytes memory args =
            abi.encode(manager, address(token), router, address(this), BUY, SELL, LP_FEE, SPACING, address(0));
        (address expected, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(VeylFeeHook).creationCode, args);
        VeylFeeHook deployed = new VeylFeeHook{salt: salt}(
            manager, address(token), router, address(this), BUY, SELL, LP_FEE, SPACING, address(0)
        );
        assertEq(address(deployed), expected);
        assertEq(uint160(address(deployed)) & Hooks.ALL_HOOK_MASK, FLAGS);
        assertEq(address(deployed.revenueRouter()), address(router));
    }

    receive() external payable {}
}

contract NestedFlush is IUnlockCallback {
    IPoolManager private immutable manager;
    VeylFeeHook private immutable hook;
    bool public succeeded;

    constructor(IPoolManager manager_, VeylFeeHook hook_) {
        manager = manager_;
        hook = hook_;
    }

    function attempt() external {
        manager.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (succeeded,) = address(hook).call(abi.encodeCall(VeylFeeHook.flushFees, ()));
        return "";
    }
}

contract RejectRevenue {
    receive() external payable {
        revert();
    }
}
