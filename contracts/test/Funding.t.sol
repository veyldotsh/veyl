// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {RevenueRouter, JobEscrow} from "../src/Funding.sol";

contract FundingTest is Test {
    RevenueRouter router;
    JobEscrow escrow;
    address treasury = address(0x111);
    address creator = address(0x222);
    address protocol = address(0x333);
    address customer = address(0x444);
    address worker = address(0x555);

    function setUp() public {
        router = new RevenueRouter(treasury, creator, protocol);
        escrow = new JobEscrow();
        vm.deal(address(this), 100 ether);
        vm.deal(customer, 10 ether);
    }

    function testFuzzSplitConservesEveryWei(uint96 value) public {
        value = uint96(bound(value, 1, 10 ether));
        (bool ok,) = address(router).call{value: value}("");
        assertTrue(ok);
        assertEq(router.claimable(treasury), uint256(value) * 7 / 10);
        assertEq(router.claimable(creator), uint256(value) / 5);
        assertEq(router.claimable(protocol), uint256(value) - uint256(value) * 7 / 10 - uint256(value) / 5);
        assertEq(router.claimable(treasury) + router.claimable(creator) + router.claimable(protocol), value);
        router.distribute(payable(protocol));
        if (router.claimable(treasury) > 0) router.distribute(payable(treasury));
        if (router.claimable(creator) > 0) router.distribute(payable(creator));
        assertEq(address(router).balance, 0);
        assertEq(treasury.balance + creator.balance + protocol.balance, value);
    }

    function testPermissionlessDeliveryCannotRedirectFunds() public {
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        router.distribute(payable(treasury));
        assertEq(treasury.balance, 0.7 ether);
        vm.expectRevert("nothing owed");
        router.claim(payable(address(this)));
    }

    function testRejectingRecipientDoesNotBlockOthers() public {
        RejectFunding rejector = new RejectFunding();
        RevenueRouter r = new RevenueRouter(treasury, address(rejector), protocol);
        (bool ok,) = address(r).call{value: 1 ether}("");
        assertTrue(ok);
        vm.expectRevert("transfer failed");
        r.distribute(payable(address(rejector)));
        assertEq(r.claimable(address(rejector)), 0.2 ether);
        r.distribute(payable(treasury));
        assertEq(treasury.balance, 0.7 ether);
        r.distribute(payable(protocol));
        assertEq(protocol.balance, 0.1 ether);
        assertEq(address(r).balance, 0.2 ether);
    }

    function testClaimsCannotBeRepeatedAndOnlyBeneficiaryCanRedirect() public {
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(creator);
        router.claim(payable(customer));
        assertEq(customer.balance, 10.2 ether);
        assertEq(router.claimable(creator), 0);
        vm.expectRevert("nothing owed");
        vm.prank(creator);
        router.claim(payable(customer));
        vm.expectRevert("nothing owed");
        router.distribute(payable(creator));
        router.distribute(payable(treasury));
        vm.expectRevert("nothing owed");
        router.distribute(payable(treasury));
        assertEq(router.claimable(protocol), 0.1 ether);
    }

    function testRoundingRemainderGoesToProtocol() public {
        (bool ok,) = address(router).call{value: 9}("");
        assertTrue(ok);
        assertEq(router.claimable(treasury), 6);
        assertEq(router.claimable(creator), 1);
        assertEq(router.claimable(protocol), 2);
    }

    function testRejectsZeroRecipients() public {
        vm.expectRevert("zero recipient");
        new RevenueRouter(address(0), creator, protocol);
        vm.expectRevert("zero recipient");
        new RevenueRouter(treasury, address(0), protocol);
        vm.expectRevert("zero recipient");
        new RevenueRouter(treasury, creator, address(0));
    }

    function testSharedBeneficiaryAccumulatesAndClaimsAllSharesOnce() public {
        RevenueRouter shared = new RevenueRouter(treasury, treasury, treasury);
        (bool ok,) = address(shared).call{value: 17}("");
        assertTrue(ok);
        assertEq(shared.claimable(treasury), 17);
        shared.distribute(payable(treasury));
        assertEq(treasury.balance, 17);
        assertEq(address(shared).balance, 0);
        vm.expectRevert("nothing owed");
        shared.distribute(payable(treasury));
    }

    function testClaimReentrancyCannotSpendAnotherShareOrPayTwice() public {
        ReentrantClaim receiver = new ReentrantClaim();
        RevenueRouter target = new RevenueRouter(address(receiver), creator, protocol);
        receiver.setRouter(target);
        (bool ok,) = address(target).call{value: 1 ether}("");
        assertTrue(ok);
        target.distribute(payable(address(receiver)));
        assertTrue(receiver.attempted());
        assertFalse(receiver.succeeded());
        assertEq(address(receiver).balance, 0.7 ether);
        assertEq(target.claimable(address(receiver)), 0);
        assertEq(target.claimable(creator), 0.2 ether);
        assertEq(target.claimable(protocol), 0.1 ether);
    }

    function openJob() internal returns (bytes32 id) {
        vm.prank(customer);
        return
            escrow.open{value: 1 ether}(
                bytes32(uint256(1)), worker, uint64(block.timestamp + 1 days), keccak256("brief")
            );
    }

    function testEscrowAcceptPaysOnce() public {
        bytes32 id = openJob();
        vm.prank(worker);
        escrow.submit(id, keccak256("result"));
        vm.prank(customer);
        escrow.accept(id);
        assertEq(worker.balance, 1 ether);
        vm.expectRevert("customer only or closed");
        vm.prank(customer);
        escrow.accept(id);
    }

    function testEscrowRefundOnlyCustomerAfterDeadline() public {
        bytes32 id = openJob();
        vm.expectRevert("not expired");
        vm.prank(customer);
        escrow.refund(id);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert("customer only or closed");
        vm.prank(worker);
        escrow.refund(id);
        vm.prank(customer);
        escrow.refund(id);
        assertEq(customer.balance, 10 ether);
    }

    function testWorkerCannotAcceptOrSubstituteCustomer() public {
        bytes32 id = openJob();
        vm.expectRevert("customer only or closed");
        vm.prank(worker);
        escrow.accept(id);
        vm.expectRevert("worker only or closed");
        escrow.submit(id, keccak256("fake"));
        vm.expectRevert("no result");
        vm.prank(customer);
        escrow.accept(id);
    }
}

contract RejectFunding {
    receive() external payable {
        revert();
    }
}

contract ReentrantClaim {
    RevenueRouter private target;
    bool public attempted;
    bool public succeeded;

    function setRouter(RevenueRouter value) external {
        require(address(target) == address(0));
        target = value;
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        (succeeded,) = address(target).call(abi.encodeCall(RevenueRouter.claim, (payable(address(this)))));
    }
}
