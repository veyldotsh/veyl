// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {VeylFeeHook} from "./hook/VeylFeeHook.sol";

/// @notice Exact-input swaps through one immutable native-ETH/token or VEYL/agent pool.
/// @dev No exact-output, arbitrary routes, payer/recipient overrides, permit or delegated execution.
/// Supports the plain fixed-supply AgentToken; transfer-tax/rebasing tokens are unsupported.
/// Buys spend the specified quote input completely or revert, including the hook fee. Partial sells pull only the
/// tokens actually consumed. Output minimums apply after the hook fee; callers must set both their
/// minimum output and a suitable deadline. No administration, sweep or standing manager approval.
contract VeylSwapRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    VeylFeeHook public immutable hook;
    IPoolManager public immutable poolManager;
    IERC20 public immutable token;
    address public immutable quoteAsset;
    bool public immutable tokenIsCurrency0;
    PoolId public immutable poolId;
    uint24 private immutable lpFee;
    int24 private immutable tickSpacing;

    struct Request {
        address payer;
        bool buy;
        uint256 amountIn;
        uint256 minOut;
        uint160 priceLimit;
    }

    Request private pending;

    error InvalidConfiguration();
    error InvalidAmount();
    error Expired();
    error UnexpectedETH();
    error NotPoolManager();
    error InvalidCallback();
    error InvalidSwapDelta();
    error MinimumOutputNotMet();
    error SettlementMismatch();

    event Swapped(address indexed caller, bool indexed isBuy, uint256 amountIn, uint256 amountOut);

    constructor(VeylFeeHook hook_) {
        if (address(hook_).code.length == 0) revert InvalidConfiguration();
        IPoolManager manager_ = hook_.poolManager();
        address token_ = hook_.token();
        address quoteAsset_ = hook_.quoteAsset();
        PoolKey memory key = hook_.getPoolKey();
        PoolId id = hook_.poolId();
        if (
            address(manager_).code.length == 0 || token_.code.length == 0
                || Currency.unwrap(key.currency0) != (token_ < quoteAsset_ ? token_ : quoteAsset_)
                || Currency.unwrap(key.currency1) != (token_ < quoteAsset_ ? quoteAsset_ : token_)
                || address(key.hooks) != address(hook_) || PoolId.unwrap(PoolIdLibrary.toId(key)) != PoolId.unwrap(id)
        ) revert InvalidConfiguration();
        hook = hook_;
        poolManager = manager_;
        token = IERC20(token_);
        quoteAsset = quoteAsset_;
        tokenIsCurrency0 = token_ < quoteAsset_;
        poolId = id;
        lpFee = key.fee;
        tickSpacing = key.tickSpacing;
    }

    function getPoolKey() public view returns (PoolKey memory) {
        return PoolKey(
            Currency.wrap(tokenIsCurrency0 ? address(token) : quoteAsset),
            Currency.wrap(tokenIsCurrency0 ? quoteAsset : address(token)),
            lpFee,
            tickSpacing,
            IHooks(address(hook))
        );
    }

    /// @param minTokensOut Minimum tokens received by msg.sender, after all pool/hook charges.
    /// @param sqrtPriceLimitX96 Absolute v4 pool price limit; buys that only partially fill revert.
    /// @param deadline Last accepted block timestamp, inclusive.
    function buy(uint256 quoteAmountIn, uint256 minTokensOut, uint160 sqrtPriceLimitX96, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.value != (quoteAsset == address(0) ? quoteAmountIn : 0)) revert UnexpectedETH();
        (, tokensOut) = _execute(true, quoteAmountIn, minTokensOut, sqrtPriceLimitX96, deadline);
    }

    /// @notice Approve this router for tokenAmountIn first. Unspent tokens stay with the caller.
    /// @return tokensSpent Actual input consumed, which can be less than tokenAmountIn at the price limit.
    /// @return quoteOut Quote currency delivered directly to msg.sender, net of the hook fee.
    function sell(uint256 tokenAmountIn, uint256 minQuoteOut, uint160 sqrtPriceLimitX96, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensSpent, uint256 quoteOut)
    {
        if (msg.value != 0) revert UnexpectedETH();
        return _execute(false, tokenAmountIn, minQuoteOut, sqrtPriceLimitX96, deadline);
    }

    function _execute(bool buy_, uint256 amountIn, uint256 minOut, uint160 limit, uint256 deadline)
        private
        returns (uint256 spent, uint256 received)
    {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max)) || minOut == 0) revert InvalidAmount();
        pending = Request(msg.sender, buy_, amountIn, minOut, limit);
        (spent, received) = abi.decode(poolManager.unlock(""), (uint256, uint256));
        if (pending.payer != address(0)) revert InvalidCallback();
        emit Swapped(msg.sender, buy_, spent, received);
    }

    /// @dev Only the configured manager may consume the active, internally stored request, once.
    /// No externally supplied payer, currency, recipient, swap parameters or hook data are decoded.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Request memory request = pending;
        if (request.payer == address(0) || data.length != 0) revert InvalidCallback();
        delete pending;

        bool zeroForOne = request.buy != tokenIsCurrency0;
        BalanceDelta delta =
            poolManager.swap(getPoolKey(), SwapParams(zeroForOne, -int256(request.amountIn), request.priceLimit), "");
        int128 input = zeroForOne ? delta.amount0() : delta.amount1();
        int128 output = zeroForOne ? delta.amount1() : delta.amount0();
        if (input >= 0 || output <= 0) revert InvalidSwapDelta();
        uint256 spent = uint256(-int256(input));
        uint256 received = uint256(uint128(output));
        if (spent > request.amountIn || (request.buy && spent != request.amountIn)) revert InvalidSwapDelta();
        if (received < request.minOut) revert MinimumOutputNotMet();

        _settle(request.buy ? quoteAsset : address(token), request.payer, spent);
        _take(request.buy ? address(token) : quoteAsset, request.payer, received);
        return abi.encode(spent, received);
    }

    function _settle(address asset, address payer, uint256 amount) private {
        poolManager.sync(Currency.wrap(asset));
        if (asset == address(0)) {
            if (poolManager.settle{value: amount}() != amount) revert SettlementMismatch();
        } else {
            IERC20 currency = IERC20(asset);
            uint256 beforeBalance = currency.balanceOf(payer);
            currency.safeTransferFrom(payer, address(poolManager), amount);
            if (poolManager.settle() != amount || currency.balanceOf(payer) + amount != beforeBalance) {
                revert SettlementMismatch();
            }
        }
    }

    function _take(address asset, address recipient, uint256 amount) private {
        if (asset == address(0)) {
            poolManager.take(Currency.wrap(asset), recipient, amount);
        } else {
            uint256 beforeBalance = IERC20(asset).balanceOf(recipient);
            poolManager.take(Currency.wrap(asset), recipient, amount);
            if (IERC20(asset).balanceOf(recipient) != beforeBalance + amount) revert SettlementMismatch();
        }
    }

    // Swaps never receive output through the router. Ordinary direct transfers are mistakes.
    receive() external payable {
        revert UnexpectedETH();
    }
}
