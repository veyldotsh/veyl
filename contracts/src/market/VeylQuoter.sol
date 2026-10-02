// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {VeylFeeHook} from "../hook/VeylFeeHook.sol";

/// @notice Revert-based simulation against the actual PoolManager and fee hook. Use eth_call.
/// @dev The swap callback always reverts, undoing pool/claim changes before a quote is returned.
/// No tokens, allowances or ETH funding are used. Quotes are not promises of future execution.
contract VeylQuoter is IUnlockCallback, ReentrancyGuard {
    using StateLibrary for IPoolManager;
    IPoolManager public immutable poolManager;

    struct Quote {
        uint256 amountIn;
        uint256 amountOut;
        uint256 hookFee;
        uint160 sqrtPriceX96After;
        int24 tickAfter;
        uint128 liquidityAfter;
    }

    struct Request {
        VeylFeeHook hook;
        bool buy;
        uint256 amountIn;
        uint160 priceLimit;
    }
    Request private pending;
    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidCallback();
    error InvalidDelta();
    error QuoteResult(Quote quote);

    constructor(IPoolManager manager_) {
        if (address(manager_).code.length == 0) revert InvalidConfiguration();
        poolManager = manager_;
    }

    function getPoolState(VeylFeeHook hook) public view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity) {
        _checkHook(hook);
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(hook.poolId());
        liquidity = poolManager.getLiquidity(hook.poolId());
    }

    /// @notice Exact rounded-up initial seed costs at an explicitly selected initial price.
    function previewSeed(uint160 price, int24 lower, int24 upper, uint128 liquidity)
        public
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        (uint160 a, uint160 b) = _bounds(price, lower, upper);
        if (liquidity == 0 || liquidity > uint128(type(int128).max)) revert InvalidAmount();
        if (price < b) amount0 = SqrtPriceMath.getAmount0Delta(price > a ? price : a, b, liquidity, true);
        if (price > a) amount1 = SqrtPriceMath.getAmount1Delta(a, price < b ? price : b, liquidity, true);
    }

    /// @notice Derive affordable liquidity and exact seed costs from user-selected maximum amounts.
    function previewLiquidity(uint160 price, int24 lower, int24 upper, uint256 maxAmount0, uint256 maxAmount1)
        external
        pure
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        (uint160 a, uint160 b) = _bounds(price, lower, upper);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(price, a, b, maxAmount0, maxAmount1);
        (amount0, amount1) = previewSeed(price, lower, upper, liquidity);
        if (amount0 > maxAmount0 || amount1 > maxAmount1) revert InvalidAmount();
    }

    function _bounds(uint160 price, int24 lower, int24 upper) private pure returns (uint160 a, uint160 b) {
        if (
            price < TickMath.MIN_SQRT_PRICE || price >= TickMath.MAX_SQRT_PRICE || lower < TickMath.MIN_TICK
                || upper > TickMath.MAX_TICK || lower >= upper
        ) revert InvalidConfiguration();
        a = TickMath.getSqrtPriceAtTick(lower);
        b = TickMath.getSqrtPriceAtTick(upper);
    }

    function quoteExactInput(VeylFeeHook hook, bool buy, uint256 amountIn, uint160 sqrtPriceLimitX96)
        external
        nonReentrant
        returns (Quote memory quote)
    {
        _checkHook(hook);
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max))) revert InvalidAmount();
        pending = Request(hook, buy, amountIn, sqrtPriceLimitX96);
        try poolManager.unlock("") returns (bytes memory) {
            revert InvalidCallback();
        } catch (bytes memory reason) {
            delete pending;
            if (reason.length != 196 || bytes4(reason) != QuoteResult.selector) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
            // Six static tuple fields follow the custom-error selector.
            assembly ("memory-safe") {
                reason := add(reason, 4)
                mstore(reason, 192)
            }
            quote = abi.decode(reason, (Quote));
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        Request memory request = pending;
        if (msg.sender != address(poolManager) || address(request.hook) == address(0) || data.length != 0) {
            revert InvalidCallback();
        }
        delete pending;
        uint256 feeBefore = request.hook.pendingFees();
        bool zeroForOne = request.buy != request.hook.tokenIsCurrency0();
        BalanceDelta delta = poolManager.swap(
            request.hook.getPoolKey(), SwapParams(zeroForOne, -int256(request.amountIn), request.priceLimit), ""
        );
        int128 input = zeroForOne ? delta.amount0() : delta.amount1();
        int128 output = zeroForOne ? delta.amount1() : delta.amount0();
        if (input >= 0 || output <= 0) revert InvalidDelta();
        Quote memory quote;
        quote.amountIn = uint256(-int256(input));
        quote.amountOut = uint256(uint128(output));
        quote.hookFee = request.hook.pendingFees() - feeBefore;
        (quote.sqrtPriceX96After, quote.tickAfter, quote.liquidityAfter) = getPoolState(request.hook);
        revert QuoteResult(quote);
    }

    function _checkHook(VeylFeeHook hook) private view {
        if (address(hook).code.length == 0 || address(hook.poolManager()) != address(poolManager)) {
            revert InvalidConfiguration();
        }
    }
}
