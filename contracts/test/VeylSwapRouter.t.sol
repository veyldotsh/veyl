// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {AgentToken} from "../src/AgentKit.sol";
import {RevenueRouter} from "../src/Funding.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";

contract VeylSwapRouterTest is Test {
    uint16 constant BUY = 250;
    uint16 constant SELL = 375;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    PoolManager manager;
    AgentToken token;
    RevenueRouter revenue;
    VeylFeeHook hook;
    VeylSwapRouter router;
    PoolKey key;
    address trader = address(0xB0B);

    function setUp() public {
        manager = new PoolManager(address(this));
        token = new AgentToken("Agent", "AGT", address(this), false, address(0));
        revenue = new RevenueRouter(address(0x111), address(0x222), address(0x333));
        address location = address(uint160((9000 << 14) | FLAGS));
        deployCodeTo(
            "VeylFeeHook.sol:VeylFeeHook",
            abi.encode(manager, address(token), revenue, address(this), BUY, SELL, uint24(3000), int24(60), address(0)),
            location
        );
        hook = VeylFeeHook(payable(location));
        router = new VeylSwapRouter(hook);
        key = hook.getPoolKey();
        manager.initialize(key, 79228162514264337593543950336);
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(manager);
        vm.deal(address(this), 10_000 ether);
        token.approve(address(liquidity), type(uint256).max);
        liquidity.modifyLiquidity{value: 1000 ether}(
            key, ModifyLiquidityParams(-600, 600, 10_000 ether, bytes32(0)), ""
        );
        vm.deal(trader, 100 ether);
        token.transfer(trader, 1000 ether);
        vm.prank(trader);
        token.approve(address(router), 1000 ether);
    }

    function _buy(uint256 amount, uint256 minimum) private returns (uint256) {
        vm.prank(trader);
        return router.buy{value: amount}(amount, minimum, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
    }

    function _sell(uint256 amount, uint256 minimum) private returns (uint256, uint256) {
        vm.prank(trader);
        return router.sell(amount, minimum, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
    }

    function testImmutablePoolBinding() public view {
        assertEq(address(router.hook()), address(hook));
        assertEq(address(router.poolManager()), address(manager));
        assertEq(address(router.token()), address(token));
        assertEq(PoolId.unwrap(router.poolId()), PoolId.unwrap(hook.poolId()));
        assertEq(PoolId.unwrap(PoolIdLibrary.toId(router.getPoolKey())), PoolId.unwrap(hook.poolId()));
    }

    function testBuySettlesCallerETHAndPaysOnlyCallerTokens() public {
        uint256 beforeETH = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        uint256 beforeManager = address(manager).balance;
        uint256 received = _buy(1 ether, 0.9 ether);
        assertGe(received, 0.9 ether);
        assertEq(beforeETH - trader.balance, 1 ether);
        assertEq(token.balanceOf(trader) - beforeToken, received);
        assertEq(address(manager).balance - beforeManager, 1 ether);
        assertEq(hook.pendingFees(), 1 ether * uint256(BUY) / 10_000);
        assertEq(address(router).balance, 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.allowance(address(router), address(manager)), 0);
    }

    function testSellSettlesActualTokensAndPaysNetETH() public {
        uint256 beforeETH = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        uint256 beforeManager = address(manager).balance;
        (uint256 spent, uint256 received) = _sell(1 ether, 0.9 ether);
        uint256 fee = hook.pendingFees();
        assertEq(spent, 1 ether);
        assertEq(beforeToken - token.balanceOf(trader), spent);
        assertEq(trader.balance - beforeETH, received);
        assertEq(beforeManager - address(manager).balance, received);
        assertEq(fee, (received + fee) * SELL / 10_000);
        assertEq(token.allowance(trader, address(router)), 1000 ether - spent);
        assertEq(address(router).balance, 0);
        assertEq(token.balanceOf(address(router)), 0);
        hook.flushFees();
        assertEq(address(revenue).balance, fee);
        assertEq(revenue.claimable(address(0x111)), fee * 7 / 10);
        assertEq(revenue.claimable(address(0x222)), fee / 5);
        assertEq(revenue.claimable(address(0x333)), fee - fee * 7 / 10 - fee / 5);
    }

    function testPartialSellOnlyPullsConsumedTokens() public {
        uint256 beforeToken = token.balanceOf(trader);
        uint256 beforeETH = trader.balance;
        vm.prank(trader);
        (uint256 spent, uint256 received) = router.sell(10 ether, 1, TickMath.getSqrtPriceAtTick(1), block.timestamp);
        assertGt(spent, 0);
        assertLt(spent, 10 ether);
        assertEq(beforeToken - token.balanceOf(trader), spent);
        assertEq(token.allowance(trader, address(router)), 1000 ether - spent);
        assertEq(trader.balance - beforeETH, received);
        uint256 fee = hook.pendingFees();
        assertEq(fee, (received + fee) * SELL / 10_000);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testPartialBuyRevertsAndReturnsEntireCallValue() public {
        uint256 beforeETH = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(VeylFeeHook.PartialFillUnsupported.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        vm.prank(trader);
        router.buy{value: 10 ether}(10 ether, 1, TickMath.getSqrtPriceAtTick(-1), block.timestamp);
        assertEq(trader.balance, beforeETH);
        assertEq(token.balanceOf(trader), beforeToken);
        assertEq(hook.pendingFees(), 0);
        assertEq(address(router).balance, 0);
        _buy(1 ether, 1);
    }

    function testBuySlippageRollsBackPaymentAndHookClaims() public {
        uint256 beforeETH = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        uint256 beforeManager = address(manager).balance;
        vm.expectRevert(VeylSwapRouter.MinimumOutputNotMet.selector);
        _buy(1 ether, 2 ether);
        assertEq(trader.balance, beforeETH);
        assertEq(token.balanceOf(trader), beforeToken);
        assertEq(address(manager).balance, beforeManager);
        assertEq(hook.pendingFees(), 0);
        _buy(1 ether, 1);
    }

    function testSellMinimumAppliesToNetETHAfterHookFee() public {
        uint256 snapshot = vm.snapshotState();
        (, uint256 net) = _sell(1 ether, 1);
        assertGt(hook.pendingFees(), 1);
        assertTrue(vm.revertToState(snapshot));
        uint256 beforeToken = token.balanceOf(trader);
        uint256 beforeETH = trader.balance;
        vm.expectRevert(VeylSwapRouter.MinimumOutputNotMet.selector);
        _sell(1 ether, net + 1);
        assertEq(token.balanceOf(trader), beforeToken);
        assertEq(trader.balance, beforeETH);
        assertEq(token.allowance(trader, address(router)), 1000 ether);
        assertEq(hook.pendingFees(), 0);
        (, uint256 actual) = _sell(1 ether, net);
        assertEq(actual, net);
    }

    function testExpiredBuysAndSellsCannotMoveFunds() public {
        vm.warp(100);
        uint256 beforeETH = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        vm.expectRevert(VeylSwapRouter.Expired.selector);
        vm.prank(trader);
        router.buy{value: 1 ether}(1 ether, 1, TickMath.MIN_SQRT_PRICE + 1, 99);
        vm.expectRevert(VeylSwapRouter.Expired.selector);
        vm.prank(trader);
        router.sell(1 ether, 1, TickMath.MAX_SQRT_PRICE - 1, 99);
        assertEq(trader.balance, beforeETH);
        assertEq(token.balanceOf(trader), beforeToken);
        assertEq(hook.pendingFees(), 0);
    }

    function testInvalidAmountsAndUnexpectedETHRejected() public {
        vm.expectRevert(VeylSwapRouter.InvalidAmount.selector);
        _buy(0, 1);
        vm.expectRevert(VeylSwapRouter.InvalidAmount.selector);
        _buy(1 ether, 0);
        vm.expectRevert(VeylSwapRouter.InvalidAmount.selector);
        _sell(0, 1);
        vm.expectRevert(VeylSwapRouter.InvalidAmount.selector);
        _sell(uint256(uint128(type(int128).max)) + 1, 1);
        vm.expectRevert(VeylSwapRouter.UnexpectedETH.selector);
        vm.prank(trader);
        router.sell{value: 1}(1 ether, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
        assertEq(hook.pendingFees(), 0);
    }

    function testCannotSpendVictimApprovalsOrDonatedRouterBalances() public {
        address attacker = address(0xBAD);
        token.transfer(address(router), 3 ether);
        vm.deal(address(router), 5 ether);
        uint256 beforeVictim = token.balanceOf(trader);
        vm.expectRevert();
        vm.prank(attacker);
        router.sell(1 ether, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
        assertEq(token.balanceOf(trader), beforeVictim);
        assertEq(token.allowance(trader, address(router)), 1000 ether);
        assertEq(token.balanceOf(address(router)), 3 ether);
        assertEq(hook.pendingFees(), 0);
        _buy(1 ether, 1);
        assertEq(address(router).balance, 5 ether);
        assertEq(token.balanceOf(address(router)), 3 ether);
    }

    function testCallbacksAndDirectETHAreRejectedOutsideActiveSwap() public {
        vm.expectRevert(VeylSwapRouter.NotPoolManager.selector);
        router.unlockCallback(abi.encode(trader));
        vm.expectRevert(VeylSwapRouter.InvalidCallback.selector);
        vm.prank(address(manager));
        router.unlockCallback("");
        vm.expectRevert(VeylSwapRouter.InvalidCallback.selector);
        vm.prank(address(manager));
        router.unlockCallback(abi.encode(trader));
        (bool ok,) = address(router).call{value: 1}("");
        assertFalse(ok);
        _buy(1 ether, 1);
        vm.expectRevert(VeylSwapRouter.InvalidCallback.selector);
        vm.prank(address(manager));
        router.unlockCallback("");
    }

    function testNativeSettlementResetsForeignTransientTokenSync() public {
        manager.sync(Currency.wrap(address(token)));
        uint256 received = _buy(1 ether, 1);
        assertGt(received, 0);
        assertEq(hook.pendingFees(), 1 ether * uint256(BUY) / 10_000);
    }

    function testETHRecipientCannotReenterBuySellOrCallback() public {
        RouterRecipient recipient = new RouterRecipient(router, IERC20(address(token)));
        token.transfer(address(recipient), 2 ether);
        (, uint256 received) = recipient.sell(false);
        assertGt(received, 0);
        assertEq(address(recipient).balance, received);
        assertFalse(recipient.buyReentered());
        assertFalse(recipient.sellReentered());
        assertFalse(recipient.callbackReentered());
        assertEq(recipient.buyError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(recipient.sellError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(token.balanceOf(address(recipient)), 1 ether);
    }

    function testETHDeliveryFailureRollsBackTokenPaymentAndHookFee() public {
        RouterRecipient recipient = new RouterRecipient(router, IERC20(address(token)));
        token.transfer(address(recipient), 2 ether);
        uint256 beforeManagerToken = token.balanceOf(address(manager));
        uint256 beforeManagerETH = address(manager).balance;
        vm.expectRevert();
        recipient.sell(true);
        assertEq(token.balanceOf(address(recipient)), 2 ether);
        assertEq(token.allowance(address(recipient), address(router)), 0);
        assertEq(token.balanceOf(address(manager)), beforeManagerToken);
        assertEq(address(manager).balance, beforeManagerETH);
        assertEq(hook.pendingFees(), 0);
        recipient.sell(false);
    }

    function testInsufficientTokenPaymentRollsBackSwapAndFee() public {
        vm.prank(trader);
        token.approve(address(router), 0);
        uint256 beforeETH = trader.balance;
        uint256 beforeManager = token.balanceOf(address(manager));
        vm.expectRevert();
        _sell(1 ether, 1);
        assertEq(trader.balance, beforeETH);
        assertEq(token.balanceOf(address(manager)), beforeManager);
        assertEq(hook.pendingFees(), 0);
        vm.prank(trader);
        token.approve(address(router), 1 ether);
        _sell(1 ether, 1);
    }

    function testFuzzBuyAndSellConserveSettledAmounts(uint96 value) public {
        uint256 amount = bound(value, 1000, 1 ether);
        uint256 beforeETH = trader.balance;
        uint256 beforeToken = token.balanceOf(trader);
        uint256 bought = _buy(amount, 1);
        assertEq(beforeETH - trader.balance, amount);
        assertEq(token.balanceOf(trader) - beforeToken, bought);
        (uint256 spent, uint256 received) = _sell(bought, 1);
        assertEq(spent, bought);
        assertEq(token.balanceOf(trader), beforeToken);
        assertEq(trader.balance, beforeETH - amount + received);
        uint256 owed = hook.pendingFees();
        hook.flushFees();
        assertEq(address(revenue).balance, owed);
        assertEq(address(router).balance, 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testConstructorRejectsMissingHookCode() public {
        vm.expectRevert(VeylSwapRouter.InvalidConfiguration.selector);
        new VeylSwapRouter(VeylFeeHook(payable(address(0))));
    }

    receive() external payable {}
}

contract RouterRecipient {
    VeylSwapRouter private immutable router;
    IERC20 private immutable token;
    bool private reject;
    bool public buyReentered;
    bool public sellReentered;
    bool public callbackReentered;
    bytes4 public buyError;
    bytes4 public sellError;

    constructor(VeylSwapRouter router_, IERC20 token_) {
        router = router_;
        token = token_;
    }

    function sell(bool reject_) external returns (uint256, uint256) {
        reject = reject_;
        token.approve(address(router), 1 ether);
        return router.sell(1 ether, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
    }

    receive() external payable {
        require(!reject, "reject ETH");
        bytes memory reason;
        (buyReentered, reason) = address(router).call{value: 1}(
            abi.encodeCall(VeylSwapRouter.buy, (1, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp))
        );
        buyError = bytes4(reason);
        (sellReentered, reason) = address(router)
            .call(abi.encodeCall(VeylSwapRouter.sell, (1, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp)));
        sellError = bytes4(reason);
        (callbackReentered,) = address(router).call(abi.encodeCall(VeylSwapRouter.unlockCallback, ("")));
    }
}
