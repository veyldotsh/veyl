// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {AgentTreasury} from "../src/AgentKit.sol";
import {QuoteRevenueRouter} from "../src/QuoteRevenueRouter.sol";

contract QuoteFeeToken is ERC20 {
    address public blocked;
    bool public taxed;
    constructor() ERC20("Fixture VEYL", "FVEYL") {}

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    function blockRecipient(address recipient) external {
        blocked = recipient;
    }

    function setTax(bool enabled) external {
        taxed = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to == address(0) || to != blocked, "blocked recipient");
        if (taxed && from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0), 1);
            value--;
        }
        super._update(from, to, value);
    }
}

contract QuoteFixtureManager {
    function pay(address to, uint256 amount) external {
        (bool ok,) = to.call{value: amount}("");
        require(ok);
    }
    receive() external payable {}
}

contract QuoteRejectETH {
    receive() external payable {
        revert("reject ETH");
    }
}

contract QuoteFixtureSwapRouter {
    address public immutable token;
    address public immutable poolManager;
    address public quoteAsset;
    bool public partialFill;
    bool public incorrectResult;
    bool public tryReenter;
    bool public reentered;

    constructor(address token_, address manager_) {
        token = token_;
        poolManager = manager_;
    }

    function hook() external view returns (address) {
        return address(this);
    }

    function getPoolKey() public view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(token), 0, 200, IHooks(address(this)));
    }

    function poolId() external view returns (PoolId) {
        return PoolIdLibrary.toId(getPoolKey());
    }

    function configure(bool partial_, bool incorrect_, bool reenter_) external {
        partialFill = partial_;
        incorrectResult = incorrect_;
        tryReenter = reenter_;
    }

    function setQuoteAsset(address value) external {
        quoteAsset = value;
    }

    function sell(uint256 amount, uint256 minOut, uint160, uint256 deadline)
        external
        returns (uint256 spent, uint256 received)
    {
        require(deadline >= block.timestamp);
        spent = partialFill ? amount / 2 : amount;
        IERC20(token).transferFrom(msg.sender, address(this), spent);
        if (tryReenter) {
            (reentered,) = msg.sender.call(abi.encodeCall(QuoteRevenueRouter.convertFees, (1, 1, 1, deadline)));
        }
        received = spent; // Explicit unit fixture, not a market price prediction.
        require(received >= minOut, "slippage");
        QuoteFixtureManager(payable(poolManager)).pay(msg.sender, received);
        if (incorrectResult) received++;
    }
}

contract QuoteRevenueRouterTest is Test {
    QuoteFeeToken asset;
    AgentTreasury treasury;
    QuoteFixtureManager manager;
    QuoteFixtureSwapRouter swapper;
    QuoteRevenueRouter revenue;
    address constant OWNER = address(0xA11CE);
    address constant EXECUTOR = address(0xB0B);
    address constant CREATOR = address(0xC0FFEE);
    address constant PLATFORM = address(0xFEED);

    function setUp() public {
        asset = new QuoteFeeToken();
        treasury = new AgentTreasury(OWNER, address(0x123), 1 ether);
        manager = new QuoteFixtureManager();
        swapper = new QuoteFixtureSwapRouter(address(asset), address(manager));
        revenue = new QuoteRevenueRouter(address(asset), treasury, CREATOR, PLATFORM, address(swapper));
        asset.mint(address(this), 10_000 ether);
        vm.deal(address(manager), 10_000 ether);
    }

    function _deposit(uint256 amount) internal {
        asset.approve(address(revenue), amount);
        revenue.deposit(amount);
    }

    function _configure(uint256 perCall, uint256 perDay, uint256 floor) internal {
        vm.prank(OWNER);
        revenue.configureConversion(EXECUTOR, perCall, perDay, floor, true);
    }

    function _convert(uint256 amount, uint256 minimum) internal returns (uint256) {
        vm.prank(EXECUTOR);
        return revenue.convertFees(amount, minimum, 1, block.timestamp + 60);
    }

    function testFuzzAllQuoteConvertsBeforeETHSplitAndRoundingConservesOutput(uint128 amount) public {
        uint256 value = bound(uint256(amount), 1, 1000 ether);
        _deposit(value);
        assertEq(revenue.pendingQuote(), value);
        assertEq(revenue.claimable(CREATOR), 0);
        assertEq(revenue.claimable(address(treasury)), 0);
        assertEq(asset.allowance(address(this), address(revenue)), 0);
        _configure(1000 ether, 1000 ether, 1);
        _convert(value, value);
        assertEq(revenue.pendingQuote(), 0);
        assertEq(asset.balanceOf(address(revenue)), 0);
        assertEq(revenue.claimable(address(treasury)), value * 7000 / 10000);
        assertEq(revenue.claimable(CREATOR), value * 2000 / 10000);
        assertEq(revenue.claimable(address(treasury)) + revenue.claimable(CREATOR) + revenue.claimable(PLATFORM), value);
        assertEq(address(revenue).balance, value);
    }

    function testClaimsAreETHOnlyAndRejectingBeneficiaryCannotBlockOthers() public {
        QuoteRejectETH rejecting = new QuoteRejectETH();
        revenue = new QuoteRevenueRouter(address(asset), treasury, address(rejecting), PLATFORM, address(swapper));
        _deposit(100 ether);
        vm.expectRevert(QuoteRevenueRouter.InvalidAmount.selector);
        revenue.distribute(address(treasury));
        _configure(100 ether, 100 ether, 1);
        _convert(100 ether, 100 ether);
        vm.expectRevert(QuoteRevenueRouter.TransferFailed.selector);
        revenue.distribute(address(rejecting));
        revenue.distribute(PLATFORM);
        assertEq(PLATFORM.balance, 10 ether);
        assertEq(revenue.claimable(address(rejecting)), 20 ether);
        revenue.distribute(address(treasury));
        assertEq(address(treasury).balance, 70 ether);
        vm.prank(address(rejecting));
        revenue.claim(address(0x999));
        assertEq(address(0x999).balance, 20 ether);
        assertEq(revenue.pendingQuote(), 0);
        assertEq(asset.balanceOf(PLATFORM), 0);
        assertEq(asset.balanceOf(address(treasury)), 0);
    }

    function testDisabledByDefaultAndOnlyCurrentOwnerCanConfigure() public {
        _deposit(100 ether);
        vm.expectRevert(QuoteRevenueRouter.ConversionDisabled.selector);
        _convert(1 ether, 1);
        vm.expectRevert(QuoteRevenueRouter.NotTreasuryOwner.selector);
        revenue.configureConversion(EXECUTOR, 10 ether, 20 ether, 1, true);
        vm.prank(OWNER);
        treasury.transferOwnership(address(0x567));
        vm.expectRevert(QuoteRevenueRouter.NotTreasuryOwner.selector);
        _configure(10 ether, 20 ether, 1);
        vm.prank(address(0x567));
        revenue.configureConversion(EXECUTOR, 10 ether, 20 ether, 1, true);
    }

    function testConversionCreditsOnlyActualETHAndClearsAllowance() public {
        _deposit(100 ether);
        _configure(10 ether, 20 ether, 0.5 ether);
        assertEq(_convert(4 ether, 3 ether), 4 ether);
        assertEq(address(treasury).balance, 0);
        assertEq(revenue.claimable(address(treasury)), 2.8 ether);
        assertEq(revenue.pendingQuote(), 96 ether);
        assertEq(revenue.spentOnDay(block.timestamp / 1 days), 4 ether);
        assertEq(asset.allowance(address(revenue), address(swapper)), 0);
        assertEq(revenue.claimable(CREATOR), 0.8 ether);
        assertEq(revenue.claimable(PLATFORM), 0.4 ether);
        assertEq(address(revenue).balance, 4 ether);
    }

    function testOwnerFloorCannotBeWeakenedByExecutorAndRoundsUp() public {
        _deposit(100 ether);
        _configure(10 ether, 20 ether, 0.5 ether);
        vm.expectRevert(QuoteRevenueRouter.BelowOwnerFloor.selector);
        _convert(4 ether, 2 ether - 1);
        vm.expectRevert(QuoteRevenueRouter.BelowOwnerFloor.selector);
        _convert(3, 1);
        vm.expectRevert(QuoteRevenueRouter.InvalidAmount.selector);
        _convert(1, 0);
        assertEq(revenue.pendingQuote(), 100 ether);
        assertEq(revenue.spentOnDay(0), 0);
    }

    function testUnauthorisedExecutorAndInvalidDeadlineCannotConvert() public {
        _deposit(100 ether);
        _configure(10 ether, 20 ether, 1);
        vm.expectRevert(QuoteRevenueRouter.NotConversionExecutor.selector);
        revenue.convertFees(1 ether, 1, 1, block.timestamp + 60);
        vm.expectRevert(QuoteRevenueRouter.InvalidDeadline.selector);
        vm.prank(EXECUTOR);
        revenue.convertFees(1 ether, 1, 1, block.timestamp);
        vm.expectRevert(QuoteRevenueRouter.InvalidDeadline.selector);
        vm.prank(EXECUTOR);
        revenue.convertFees(1 ether, 1, 1, block.timestamp + 301);
        vm.prank(OWNER);
        revenue.configureConversion(address(0), 0, 0, 0, false);
        vm.expectRevert(QuoteRevenueRouter.ConversionDisabled.selector);
        _convert(1 ether, 1);
    }

    function testTransactionAndDayLimitsHoldAcrossPolicyUpdatesAndResetAtUTCDay() public {
        _deposit(100 ether);
        _configure(10 ether, 15 ether, 1);
        vm.expectRevert(QuoteRevenueRouter.ConversionLimitExceeded.selector);
        _convert(11 ether, 100);
        _convert(10 ether, 100);
        _configure(10 ether, 15 ether, 1);
        vm.expectRevert(QuoteRevenueRouter.ConversionLimitExceeded.selector);
        _convert(6 ether, 100);
        _convert(5 ether, 100);
        assertEq(revenue.spentOnDay(0), 15 ether);
        vm.warp(1 days);
        _convert(10 ether, 100);
        assertEq(revenue.spentOnDay(1), 10 ether);
    }

    function testPartialFillOrUnexpectedOutputRevertsAllAccountingAndApproval() public {
        _deposit(100 ether);
        _configure(10 ether, 20 ether, 1);
        swapper.configure(true, false, false);
        vm.expectRevert(QuoteRevenueRouter.SettlementMismatch.selector);
        _convert(4 ether, 100);
        assertEq(revenue.pendingQuote(), 100 ether);
        assertEq(revenue.spentOnDay(0), 0);
        assertEq(asset.balanceOf(address(revenue)), 100 ether);
        assertEq(address(treasury).balance, 0);
        assertEq(asset.allowance(address(revenue), address(swapper)), 0);
        swapper.configure(false, true, false);
        vm.expectRevert(QuoteRevenueRouter.SettlementMismatch.selector);
        _convert(4 ether, 100);
        assertEq(revenue.pendingQuote(), 100 ether);
        assertEq(address(treasury).balance, 0);
    }

    function testSlippageRevertDoesNotSpendReserveOrDailyBudget() public {
        _deposit(100 ether);
        _configure(10 ether, 20 ether, 1);
        vm.expectRevert("slippage");
        _convert(4 ether, 5 ether);
        assertEq(revenue.pendingQuote(), 100 ether);
        assertEq(revenue.spentOnDay(0), 0);
        assertEq(asset.allowance(address(revenue), address(swapper)), 0);
    }

    function testSwapCannotReenterConversion() public {
        _deposit(100 ether);
        _configure(10 ether, 20 ether, 1);
        swapper.configure(false, false, true);
        _convert(4 ether, 100);
        assertFalse(swapper.reentered());
        assertEq(revenue.claimable(address(treasury)), 2.8 ether);
    }

    function testTaxedDepositCannotUndercollateralizeClaims() public {
        asset.setTax(true);
        asset.approve(address(revenue), 100 ether);
        vm.expectRevert(QuoteRevenueRouter.SettlementMismatch.selector);
        revenue.deposit(100 ether);
        assertEq(revenue.pendingQuote(), 0);
        assertEq(asset.balanceOf(address(revenue)), 0);
    }

    function testUnsolicitedTokensNeverBecomeAnUnapprovedFeeReceipt() public {
        asset.transfer(address(revenue), 100 ether);
        _deposit(10 ether);
        assertEq(revenue.pendingQuote(), 10 ether);
        assertEq(revenue.claimable(CREATOR), 0);
        assertEq(asset.balanceOf(address(revenue)), 110 ether);
    }

    function testConstructorRejectsWrongQuoteAssetAndNonNativeConversionPool() public {
        QuoteFeeToken wrong = new QuoteFeeToken();
        vm.expectRevert(QuoteRevenueRouter.InvalidConfiguration.selector);
        new QuoteRevenueRouter(address(wrong), treasury, CREATOR, PLATFORM, address(swapper));
        swapper.setQuoteAsset(address(wrong));
        vm.expectRevert(QuoteRevenueRouter.InvalidConfiguration.selector);
        new QuoteRevenueRouter(address(asset), treasury, CREATOR, PLATFORM, address(swapper));
    }

    function testETHIsAcceptedOnlyDuringVerifiedManagerSettlement() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(revenue).call{value: 1}("");
        assertFalse(ok);
        vm.expectRevert();
        manager.pay(address(revenue), 1);
    }
}
