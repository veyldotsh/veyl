// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {AgentFactory, AgentToken, AgentTreasury} from "../src/AgentKit.sol";
import {RevenueRouter} from "../src/Funding.sol";

contract AgentKitTest is Test {
    AgentFactory factory;
    AgentTreasury treasury;
    address owner = address(0xA11CE);
    address operator = address(0xB0B);
    address recipient = address(0xCAFE);
    address protocol = address(0xFEE);

    function setUp() public {
        factory = new AgentFactory(protocol);
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        (, address token, address vault) =
            factory.launch{value: 2 ether}(bytes32(uint256(1)), "Atlas", "ATLAS", operator, 0.1 ether);
        treasury = AgentTreasury(payable(vault));
        assertEq(AgentToken(token).balanceOf(owner), 1_000_000_000 ether);
        assertEq(treasury.owner(), owner);
        vm.prank(owner);
        treasury.setRecipient(recipient, true);
    }

    function testFactoryWiresFixedRevenueAllocationWithoutTaxingLaunchDeposit() public {
        bytes32 id = keccak256(abi.encode(owner, bytes32(uint256(1))));
        (address token, address vault, address creator, address routerAddress) = factory.projects(id);
        RevenueRouter router = RevenueRouter(payable(routerAddress));
        assertEq(factory.protocol(), protocol);
        assertEq(creator, owner);
        assertEq(AgentToken(token).totalSupply(), 1_000_000_000 ether);
        assertEq(vault, address(treasury));
        assertEq(router.treasury(), vault);
        assertEq(router.creator(), owner);
        assertEq(router.protocol(), protocol);
        assertEq(router.treasuryBps(), 7_000);
        assertEq(router.creatorBps(), 2_000);
        assertEq(router.protocolBps(), 1_000);
        assertEq(vault.balance, 2 ether);
        assertEq(routerAddress.balance, 0);
        assertEq(router.claimable(vault) + router.claimable(owner) + router.claimable(protocol), 0);
        assertEq(protocol.balance, 0);

        vm.deal(address(this), 1 ether);
        (bool ok,) = routerAddress.call{value: 1 ether}("");
        assertTrue(ok);
        router.distribute(payable(vault));
        router.distribute(payable(owner));
        router.distribute(payable(protocol));
        assertEq(vault.balance, 2.7 ether);
        assertEq(owner.balance, 8.2 ether);
        assertEq(protocol.balance, 0.1 ether);
        assertEq(routerAddress.balance, 0);
    }

    function testFactoryRejectsZeroProtocol() public {
        vm.expectRevert("zero protocol");
        new AgentFactory(address(0));
    }

    function testPaymentAndReplayProtection() public {
        vm.prank(operator);
        treasury.pay(bytes32(uint256(2)), payable(recipient), 0.08 ether);
        assertEq(recipient.balance, 0.08 ether);
        vm.expectRevert("duplicate or zero id");
        vm.prank(operator);
        treasury.pay(bytes32(uint256(2)), payable(recipient), 0.01 ether);
    }

    function testLimitAcrossCallsAndDays() public {
        vm.prank(operator);
        treasury.pay(bytes32(uint256(2)), payable(recipient), 0.08 ether);
        vm.expectRevert("daily limit");
        vm.prank(operator);
        treasury.pay(bytes32(uint256(3)), payable(recipient), 0.03 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        treasury.pay(bytes32(uint256(3)), payable(recipient), 0.03 ether);
    }

    function testUnauthorizedPaymentsAndConfiguration() public {
        vm.expectRevert("operator only");
        treasury.pay(bytes32(uint256(2)), payable(recipient), 1);
        vm.expectRevert();
        vm.prank(operator);
        treasury.setDailyLimit(100 ether);
        vm.expectRevert();
        vm.prank(operator);
        treasury.withdraw(payable(operator), 1 ether);
        vm.expectRevert("recipient denied");
        vm.prank(operator);
        treasury.pay(bytes32(uint256(2)), payable(owner), 1);
    }

    function testRecipientRevertDoesNotConsumeBudget() public {
        Reject target = new Reject();
        vm.prank(owner);
        treasury.setRecipient(address(target), true);
        vm.expectRevert("payment failed");
        vm.prank(operator);
        treasury.pay(bytes32(uint256(2)), payable(address(target)), 0.05 ether);
        assertEq(treasury.spentOnDay(block.timestamp / 1 days), 0);
        assertFalse(treasury.paid(bytes32(uint256(2))));
    }

    function testRecipientCannotReenterOperatorPayment() public {
        ReentrantExpense target = new ReentrantExpense(treasury);
        vm.startPrank(owner);
        treasury.setRecipient(address(target), true);
        treasury.setOperator(address(target));
        vm.stopPrank();
        target.start();
        assertTrue(target.attempted());
        assertFalse(target.succeeded());
        assertEq(address(target).balance, 0.04 ether);
        assertEq(treasury.spentOnDay(block.timestamp / 1 days), 0.04 ether);
        assertFalse(treasury.paid(bytes32(uint256(91))));
    }

    function testDuplicateLaunchRejected() public {
        vm.expectRevert("already launched");
        vm.prank(owner);
        factory.launch(bytes32(uint256(1)), "Atlas", "ATLAS", operator, 1);
    }

    function testOwnerCanRecoverOperatingFunds() public {
        uint256 balance = owner.balance;
        vm.prank(owner);
        treasury.withdraw(payable(owner), 1 ether);
        assertEq(owner.balance, balance + 1 ether);
    }

    function testFuzzSpendRespectsLimit(uint96 amount) public {
        amount = uint96(bound(amount, 1, 0.1 ether));
        vm.prank(operator);
        treasury.pay(bytes32(uint256(2)), payable(recipient), amount);
        assertEq(treasury.spentOnDay(block.timestamp / 1 days), amount);
    }
}

contract Reject {
    receive() external payable {
        revert();
    }
}

contract ReentrantExpense {
    AgentTreasury private target;
    bool public attempted;
    bool public succeeded;

    constructor(AgentTreasury target_) {
        target = target_;
    }

    function start() external {
        target.pay(bytes32(uint256(90)), payable(address(this)), 0.04 ether);
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        (succeeded,) = address(target)
            .call(abi.encodeCall(AgentTreasury.pay, (bytes32(uint256(91)), payable(address(this)), 0.04 ether)));
    }
}
