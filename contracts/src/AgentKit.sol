// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RevenueRouter} from "./Funding.sol";

/// @notice Fixed 1B supply with immutable 2% transfer/wallet caps for ten launch blocks.
/// Only the fixed PoolManager recipient is exempt from the wallet cap. There is
/// no owner, whitelist, mutable limit, pause or post-launch activation authority.
contract AgentToken is ERC20 {
    bool public immutable launchProtectionEnabled;
    uint256 public constant MAX_TRANSACTION = 20_000_000 ether;
    uint256 public constant MAX_WALLET = 20_000_000 ether;
    uint256 public constant PROTECTION_BLOCKS = 10;
    address public immutable launchFactory;
    address public immutable poolManager;
    address public bootstrapVault;
    uint256 public launchBlock;
    bool public activated;

    error NotLaunchFactory();
    error InvalidBootstrap();
    error AlreadyActivated();
    error BootstrapTransferDenied();
    error CreatorAllocationTooLarge();
    error MaxTransactionExceeded();
    error MaxWalletExceeded();
    error LaunchNotActivated();

    constructor(string memory name_, string memory symbol_, address factory_, bool protection_, address manager_)
        ERC20(name_, symbol_)
    {
        if (factory_ == address(0) || (protection_ && (manager_.code.length == 0 || factory_ == manager_))) {
            revert InvalidBootstrap();
        }
        launchProtectionEnabled = protection_;
        _mint(factory_, 1_000_000_000 ether);
        launchFactory = factory_;
        poolManager = manager_;
    }

    function setBootstrapVault(address vault) external {
        if (msg.sender != launchFactory) revert NotLaunchFactory();
        if (
            !launchProtectionEnabled || activated || bootstrapVault != address(0) || vault.code.length == 0
                || vault == launchFactory || vault == poolManager
        ) {
            revert InvalidBootstrap();
        }
        bootstrapVault = vault;
    }

    function activate() external {
        if (msg.sender != launchFactory) revert NotLaunchFactory();
        if (!launchProtectionEnabled || activated) revert AlreadyActivated();
        if (bootstrapVault == address(0) || balanceOf(bootstrapVault) != 0) revert InvalidBootstrap();
        if (balanceOf(launchFactory) > MAX_WALLET) revert CreatorAllocationTooLarge();
        activated = true;
        launchBlock = block.number;
    }

    function launchLimitsActive() public view returns (bool) {
        return launchProtectionEnabled && activated && block.number < launchBlock + PROTECTION_BLOCKS;
    }

    /// Swaps are unavailable only during atomic bootstrap. Every router is
    /// accepted after activation; the launch caps cover ERC20 transfers and
    /// balances, not ERC6909 claims or other wrapped/economic positions.
    function validateLaunchSwap() external view {
        if (launchProtectionEnabled && !activated) revert LaunchNotActivated();
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && launchProtectionEnabled) {
            if (!activated) {
                // The only pre-launch movement is the factory's atomic seed and
                // its unused-token refund. A PoolManager buy is never exempt.
                if (!((from == launchFactory && to == bootstrapVault)
                            || (from == bootstrapVault && (to == poolManager || to == launchFactory)))) {
                    revert BootstrapTransferDenied();
                }
            } else if (launchLimitsActive()) {
                if (amount > MAX_TRANSACTION) revert MaxTransactionExceeded();
                if (to != poolManager && to != address(0) && from != to && balanceOf(to) + amount > MAX_WALLET) {
                    revert MaxWalletExceeded();
                }
            }
        }
        super._update(from, to, amount);
    }
}

/// @notice Owner-controlled operating treasury; this is NOT a locked-liquidity vault.
/// Runtime spending is bounded per UTC day and only reaches approved recipients.
contract AgentTreasury is Ownable, ReentrancyGuard {
    address public operator;
    uint256 public dailyLimit;
    mapping(address => bool) public allowedRecipient;
    mapping(uint256 => uint256) public spentOnDay;
    mapping(bytes32 => bool) public paid;
    event Funded(address indexed from, uint256 amount);
    event BudgetChanged(uint256 dailyLimit);
    event OperatorChanged(address indexed operator);
    event RecipientChanged(address indexed recipient, bool allowed);
    event Expense(bytes32 indexed id, address indexed recipient, uint256 amount);
    event OwnerWithdrawal(address indexed recipient, uint256 amount);

    constructor(address owner_, address operator_, uint256 limit) Ownable(owner_) {
        operator = operator_;
        dailyLimit = limit;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function setOperator(address value) external onlyOwner {
        operator = value;
        emit OperatorChanged(value);
    }

    function setDailyLimit(uint256 value) external onlyOwner {
        dailyLimit = value;
        emit BudgetChanged(value);
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        require(recipient != address(0), "zero recipient");
        allowedRecipient[recipient] = allowed;
        emit RecipientChanged(recipient, allowed);
    }

    function pay(bytes32 id, address payable recipient, uint256 amount) external nonReentrant {
        require(msg.sender == operator, "operator only");
        require(id != bytes32(0) && !paid[id], "duplicate or zero id");
        require(allowedRecipient[recipient], "recipient denied");
        require(amount > 0 && amount <= address(this).balance, "invalid amount");
        uint256 day = block.timestamp / 1 days;
        require(spentOnDay[day] + amount <= dailyLimit, "daily limit");
        paid[id] = true;
        spentOnDay[day] += amount;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "payment failed");
        emit Expense(id, recipient, amount);
    }

    function withdraw(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        require(recipient != address(0), "zero recipient");
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "withdrawal failed");
        emit OwnerWithdrawal(recipient, amount);
    }
}

contract AgentFactory {
    struct Project {
        address token;
        address treasury;
        address owner;
        address revenueRouter;
    }
    address public immutable protocol;
    mapping(bytes32 => Project) public projects;
    event ProjectLaunched(
        bytes32 indexed id, address indexed owner, address token, address treasury, address revenueRouter
    );

    constructor(address protocol_) {
        require(protocol_ != address(0), "zero protocol");
        protocol = protocol_;
    }

    function launch(bytes32 salt, string calldata name, string calldata symbol, address operator, uint256 dailyLimit)
        external
        payable
        returns (bytes32 id, address token, address treasury)
    {
        require(bytes(name).length > 0 && bytes(name).length <= 64, "invalid name");
        require(bytes(symbol).length > 0 && bytes(symbol).length <= 10, "invalid symbol");
        id = keccak256(abi.encode(msg.sender, salt));
        require(projects[id].token == address(0), "already launched");
        token = address(new AgentToken(name, symbol, msg.sender, false, address(0)));
        treasury = address(new AgentTreasury(msg.sender, operator, dailyLimit));
        address revenueRouter = address(new RevenueRouter(treasury, msg.sender, protocol));
        projects[id] = Project(token, treasury, msg.sender, revenueRouter);
        // Launch funding is an operating deposit, not revenue: all of it reaches the treasury.
        if (msg.value > 0) {
            (bool ok,) = treasury.call{value: msg.value}("");
            require(ok, "funding failed");
        }
        emit ProjectLaunched(id, msg.sender, token, treasury, revenueRouter);
    }
}
