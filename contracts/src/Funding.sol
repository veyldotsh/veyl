// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Splits ETH receipts 70% treasury / 20% creator / 10% protocol.
/// An AMM fee collector must explicitly send fees here; this does not collect fees itself.
/// Treasury and creator shares round down per receipt; the protocol receives the remaining wei.
contract RevenueRouter is ReentrancyGuard {
    address public immutable treasury;
    address public immutable creator;
    address public immutable protocol;
    uint16 public constant treasuryBps = 7_000;
    uint16 public constant creatorBps = 2_000;
    uint16 public constant protocolBps = 1_000;
    mapping(address => uint256) public claimable;
    event Revenue(
        address indexed payer, uint256 amount, uint256 treasuryShare, uint256 creatorShare, uint256 protocolShare
    );
    event Claimed(address indexed beneficiary, address indexed destination, uint256 amount);

    constructor(address treasury_, address creator_, address protocol_) {
        require(treasury_ != address(0) && creator_ != address(0) && protocol_ != address(0), "zero recipient");
        treasury = treasury_;
        creator = creator_;
        protocol = protocol_;
    }

    receive() external payable {
        uint256 operating = msg.value * treasuryBps / 10_000;
        uint256 human = msg.value * creatorBps / 10_000;
        uint256 platform = msg.value - operating - human;
        claimable[treasury] += operating;
        claimable[creator] += human;
        claimable[protocol] += platform;
        emit Revenue(msg.sender, msg.value, operating, human, platform);
    }

    /// Anyone can deliver a beneficiary's share to that beneficiary, never redirect it.
    function distribute(address payable beneficiary) external nonReentrant {
        _pay(beneficiary, beneficiary);
    }

    /// A beneficiary can choose an alternate destination for its own share.
    function claim(address payable destination) external nonReentrant {
        require(destination != address(0), "zero destination");
        _pay(msg.sender, destination);
    }

    function _pay(address beneficiary, address payable destination) private {
        uint256 amount = claimable[beneficiary];
        require(amount > 0, "nothing owed");
        claimable[beneficiary] = 0;
        (bool ok,) = destination.call{value: amount}("");
        require(ok, "transfer failed");
        emit Claimed(beneficiary, destination, amount);
    }
}

/// @notice Simple customer-controlled job escrow. Hashes prove commitment, not correctness.
/// Customer acceptance pays the worker; after the agreed deadline the customer may refund.
/// This trades worker payment assurance for customer protection; no automatic arbitration.
contract JobEscrow is ReentrancyGuard {
    struct Job {
        address customer;
        address worker;
        uint256 value;
        uint64 deadline;
        bytes32 briefHash;
        bytes32 resultHash;
        bool closed;
    }
    mapping(bytes32 => Job) public jobs;
    event Opened(
        bytes32 indexed id,
        address indexed customer,
        address indexed worker,
        uint256 value,
        uint64 deadline,
        bytes32 briefHash
    );
    event Submitted(bytes32 indexed id, bytes32 resultHash);
    event Closed(bytes32 indexed id, bool accepted);

    function open(bytes32 salt, address worker, uint64 deadline, bytes32 briefHash)
        external
        payable
        returns (bytes32 id)
    {
        require(msg.value > 0 && worker != address(0) && briefHash != bytes32(0), "invalid job");
        require(deadline > block.timestamp && deadline <= block.timestamp + 30 days, "invalid deadline");
        id = keccak256(abi.encode(msg.sender, salt));
        require(jobs[id].customer == address(0), "duplicate job");
        jobs[id] = Job(msg.sender, worker, msg.value, deadline, briefHash, bytes32(0), false);
        emit Opened(id, msg.sender, worker, msg.value, deadline, briefHash);
    }

    function submit(bytes32 id, bytes32 resultHash) external {
        Job storage j = jobs[id];
        require(msg.sender == j.worker && !j.closed, "worker only or closed");
        require(block.timestamp < j.deadline && resultHash != bytes32(0), "invalid submission");
        j.resultHash = resultHash;
        emit Submitted(id, resultHash);
    }

    function accept(bytes32 id) external nonReentrant {
        Job storage j = jobs[id];
        require(msg.sender == j.customer && !j.closed, "customer only or closed");
        require(j.resultHash != bytes32(0), "no result");
        j.closed = true;
        (bool ok,) = j.worker.call{value: j.value}("");
        require(ok, "transfer failed");
        emit Closed(id, true);
    }

    function refund(bytes32 id) external nonReentrant {
        Job storage j = jobs[id];
        require(msg.sender == j.customer && !j.closed, "customer only or closed");
        require(block.timestamp >= j.deadline, "not expired");
        j.closed = true;
        (bool ok,) = j.customer.call{value: j.value}("");
        require(ok, "transfer failed");
        emit Closed(id, false);
    }
}
