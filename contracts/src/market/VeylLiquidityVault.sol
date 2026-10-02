// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {VeylFeeHook} from "../hook/VeylFeeHook.sol";

/// @notice Owns one permanently locked v4 liquidity position, with no owner or withdrawal path.
/// @dev One seed only. Unused seed inputs return to the immutable creator during that same call.
/// Accrued LP fees are also locked; the distinct hook fees remain payable through RevenueRouter.
contract VeylLiquidityVault is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable factory;
    address public immutable refundRecipient;
    address public immutable tokenRefundRecipient;
    VeylFeeHook public immutable hook;
    IPoolManager public immutable poolManager;
    IERC20 public immutable token;
    address public immutable quoteAsset;
    bool public immutable tokenIsCurrency0;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint128 public lockedLiquidity;
    bool public seeded;
    bool private callbackPending;
    uint256 private maxToken;
    uint256 private maxQuote;
    uint256 private minToken;
    uint256 private minQuote;

    error InvalidConfiguration();
    error NotFactory();
    error InvalidCallback();
    error AlreadySeeded();
    error SeedBounds();
    error SettlementMismatch();
    error RefundFailed();

    event LiquidityLocked(uint128 liquidity, uint256 quoteUsed, uint256 tokensUsed);

    constructor(
        address factory_,
        VeylFeeHook hook_,
        address creator_,
        int24 lower_,
        int24 upper_,
        bool protectedLaunch_
    ) {
        if (factory_ == address(0) || creator_ == address(0) || address(hook_).code.length == 0) {
            revert InvalidConfiguration();
        }
        int24 spacing = hook_.tickSpacing();
        if (
            lower_ < TickMath.MIN_TICK || upper_ > TickMath.MAX_TICK || lower_ >= upper_ || lower_ % spacing != 0
                || upper_ % spacing != 0
        ) revert InvalidConfiguration();
        factory = factory_;
        refundRecipient = creator_;
        tokenRefundRecipient = protectedLaunch_ ? factory_ : creator_;
        hook = hook_;
        poolManager = hook_.poolManager();
        token = IERC20(hook_.token());
        quoteAsset = hook_.quoteAsset();
        tokenIsCurrency0 = hook_.tokenIsCurrency0();
        tickLower = lower_;
        tickUpper = upper_;
    }

    function seed(uint128 liquidity, uint256 maxToken_, uint256 maxQuote_, uint256 minToken_, uint256 minQuote_)
        external
        payable
        nonReentrant
        returns (uint256 quoteUsed, uint256 tokensUsed)
    {
        if (msg.sender != factory) revert NotFactory();
        if (seeded) revert AlreadySeeded();
        if (
            liquidity == 0 || liquidity > uint128(type(int128).max) || minToken_ > maxToken_ || minQuote_ > maxQuote_
                || token.balanceOf(address(this)) < maxToken_ || msg.value != (quoteAsset == address(0) ? maxQuote_ : 0)
                || (quoteAsset != address(0) && IERC20(quoteAsset).balanceOf(address(this)) < maxQuote_)
        ) revert SeedBounds();
        seeded = true;
        lockedLiquidity = liquidity;
        maxToken = maxToken_;
        maxQuote = maxQuote_;
        minToken = minToken_;
        minQuote = minQuote_;
        callbackPending = true;
        (quoteUsed, tokensUsed) = abi.decode(poolManager.unlock(""), (uint256, uint256));
        if (callbackPending) revert InvalidCallback();
        if (maxToken_ > tokensUsed) _refund(address(token), tokenRefundRecipient, maxToken_ - tokensUsed);
        if (maxQuote_ > quoteUsed) _refund(quoteAsset, refundRecipient, maxQuote_ - quoteUsed);
        emit LiquidityLocked(liquidity, quoteUsed, tokensUsed);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !callbackPending || data.length != 0) revert InvalidCallback();
        callbackPending = false;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            hook.getPoolKey(),
            ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(lockedLiquidity)), bytes32(0)),
            ""
        );
        if (delta.amount0() > 0 || delta.amount1() > 0) revert SettlementMismatch();
        uint256 quoteUsed = uint256(-int256(tokenIsCurrency0 ? delta.amount1() : delta.amount0()));
        uint256 tokensUsed = uint256(-int256(tokenIsCurrency0 ? delta.amount0() : delta.amount1()));
        if (
            quoteUsed > maxQuote || tokensUsed > maxToken || quoteUsed < minQuote || tokensUsed < minToken
                || (quoteUsed == 0 && tokensUsed == 0)
        ) revert SeedBounds();
        if (quoteUsed != 0) _settle(quoteAsset, quoteUsed);
        if (tokensUsed != 0) _settle(address(token), tokensUsed);
        return abi.encode(quoteUsed, tokensUsed);
    }

    function _settle(address asset, uint256 amount) private {
        poolManager.sync(Currency.wrap(asset));
        if (asset == address(0)) {
            if (poolManager.settle{value: amount}() != amount) revert SettlementMismatch();
        } else {
            IERC20 currency = IERC20(asset);
            uint256 beforeBalance = currency.balanceOf(address(this));
            currency.safeTransfer(address(poolManager), amount);
            if (poolManager.settle() != amount || currency.balanceOf(address(this)) + amount != beforeBalance) {
                revert SettlementMismatch();
            }
        }
    }

    function _refund(address asset, address recipient, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert RefundFailed();
        } else {
            IERC20 currency = IERC20(asset);
            uint256 beforeRecipient = currency.balanceOf(recipient);
            uint256 beforeVault = currency.balanceOf(address(this));
            currency.safeTransfer(recipient, amount);
            if (
                currency.balanceOf(recipient) != beforeRecipient + amount
                    || currency.balanceOf(address(this)) + amount != beforeVault
            ) {
                revert SettlementMismatch();
            }
        }
    }
}
