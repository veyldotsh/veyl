// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapMath} from "v4-core/src/libraries/SwapMath.sol";
import {VeylQuoter} from "./VeylQuoter.sol";
import {VeylMarketTypes as T} from "./VeylMarketTypes.sol";

/// @dev Fixed launch arithmetic. The reference is a spot price, not a TWAP or an independent oracle.
library VeylAgentLaunchMath {
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint256 internal constant TARGET_FDV = 2 ether;
    uint256 internal constant MAX_DUST = 1_000_000;
    uint256 private constant Q192 = 1 << 192;
    uint256 private constant Q128 = 1 << 128;
    error InvalidLaunchTerms();
    error ReferencePriceMoved();
    error InitialBuyNotFillable();

    struct BuyState {
        uint160 price;
        int24 tick;
        uint256 remaining;
        uint256 out;
    }

    function quoteAtSqrt(uint256 baseAmount, uint160 sqrtPriceX96, bool baseIsCurrency0)
        internal
        pure
        returns (uint256)
    {
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratio = uint256(sqrtPriceX96) * sqrtPriceX96;
            return baseIsCurrency0 ? FullMath.mulDiv(baseAmount, ratio, Q192) : FullMath.mulDiv(baseAmount, Q192, ratio);
        }
        uint256 ratio128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return
            baseIsCurrency0 ? FullMath.mulDiv(baseAmount, ratio128, Q128) : FullMath.mulDiv(baseAmount, Q128, ratio128);
    }

    function standard(T.LaunchConfig memory c, bool token0, uint160 referencePrice, VeylQuoter quoter)
        internal
        view
        returns (T.LaunchConfig memory, uint256 used)
    {
        uint256 quoteFdv = quoteAtSqrt(TARGET_FDV, referencePrice, true);
        // Bounds avoid unusable/extreme price arithmetic. Actual liquidity also has a strict dust bound.
        if (quoteFdv < 1e12 || quoteFdv > type(uint128).max) revert InvalidLaunchTerms();
        uint256 ratio = token0 ? FullMath.mulDiv(quoteFdv, Q192, SUPPLY) : FullMath.mulDiv(SUPPLY, Q192, quoteFdv);
        uint256 raw = Math.sqrt(ratio);
        if (raw <= TickMath.MIN_SQRT_PRICE || raw >= TickMath.MAX_SQRT_PRICE) revert InvalidLaunchTerms();
        int24 boundary = TickMath.getTickAtSqrtPrice(uint160(raw));
        if (boundary <= TickMath.MIN_TICK || boundary >= TickMath.MAX_TICK) revert InvalidLaunchTerms();
        c.buyFeeBps = 180;
        c.sellFeeBps = 180;
        c.lpFeePips = 0;
        c.tickSpacing = 1;
        c.launchProtection = false;
        c.sqrtPriceX96 = TickMath.getSqrtPriceAtTick(boundary);
        c.tickLower = token0 ? boundary : TickMath.MIN_TICK;
        c.tickUpper = token0 ? TickMath.MAX_TICK : boundary;
        c.maxToken = SUPPLY;
        c.minToken = SUPPLY - MAX_DUST;
        c.maxQuote = 0;
        c.minQuote = 0;
        (c.liquidity,,) =
            quoter.previewLiquidity(c.sqrtPriceX96, c.tickLower, c.tickUpper, token0 ? SUPPLY : 0, token0 ? 0 : SUPPLY);
        // Amount0's intermediate division can underestimate affordable liquidity by one unit.
        if (seedCost(c, token0, quoter, c.liquidity + 1) <= SUPPLY) c.liquidity++;
        used = validate(c, token0, referencePrice, quoter);
        return (c, used);
    }

    function seedCost(T.LaunchConfig memory c, bool token0, VeylQuoter quoter, uint128 liquidity)
        internal
        view
        returns (uint256)
    {
        (uint256 amount0, uint256 amount1) = quoter.previewSeed(c.sqrtPriceX96, c.tickLower, c.tickUpper, liquidity);
        if ((token0 ? amount1 : amount0) != 0) revert InvalidLaunchTerms();
        return token0 ? amount0 : amount1;
    }

    function startingFdv(T.LaunchConfig memory c, bool token0, uint160 referencePrice) internal pure returns (uint256) {
        return quoteAtSqrt(quoteAtSqrt(SUPPLY, c.sqrtPriceX96, token0), referencePrice, false);
    }

    function validate(T.LaunchConfig memory c, bool token0, uint160 referencePrice, VeylQuoter quoter)
        internal
        view
        returns (uint256 used)
    {
        if (
            c.buyFeeBps != 180 || c.sellFeeBps != 180 || c.lpFeePips != 0 || c.tickSpacing != 1 || c.launchProtection
                || c.maxToken != SUPPLY || c.minToken != SUPPLY - MAX_DUST || c.maxQuote != 0 || c.minQuote != 0
                || c.liquidity == 0 || c.liquidity >= uint128(type(int128).max) || c.tickLower >= c.tickUpper
                || (token0 ? c.tickUpper != TickMath.MAX_TICK : c.tickLower != TickMath.MIN_TICK)
                || c.sqrtPriceX96 != TickMath.getSqrtPriceAtTick(token0 ? c.tickLower : c.tickUpper)
        ) revert InvalidLaunchTerms();
        uint256 fdv = startingFdv(c, token0, referencePrice);
        // At most 50 basis points from the 2 ETH spot-based target at execution.
        if (fdv < TARGET_FDV * 9950 / 10_000 || fdv > TARGET_FDV * 10050 / 10_000) {
            revert ReferencePriceMoved();
        }
        used = seedCost(c, token0, quoter, c.liquidity);
        if (used > SUPPLY || SUPPLY - used > MAX_DUST || seedCost(c, token0, quoter, c.liquidity + 1) <= SUPPLY) {
            revert InvalidLaunchTerms();
        }
    }

    /// @dev Reproduces each v4 bitmap-word step of the first buy, including per-step integer rounding.
    /// The new pool has exactly two initialized ticks, one position, spacing1, and zero LP/protocol fee.
    function initialBuy(T.LaunchConfig memory c, bool token0, uint256 quoteAmount, uint160 limit)
        internal
        pure
        returns (uint256 tokensOut, uint256 hookFee, uint160 price)
    {
        if (quoteAmount > uint256(uint128(type(int128).max))) revert InitialBuyNotFillable();
        bool zeroForOne = !token0;
        price = c.sqrtPriceX96;
        if (zeroForOne
                ? limit <= TickMath.MIN_SQRT_PRICE || limit >= price
                : limit >= TickMath.MAX_SQRT_PRICE || limit <= price) revert InitialBuyNotFillable();
        if (quoteAmount == 0) return (0, 0, price);
        hookFee = quoteAmount * 180 / 10_000;
        // For currency1 token the first zero-amount step activates liquidity at the upper boundary.
        BuyState memory state = BuyState(price, token0 ? c.tickLower : c.tickUpper - 1, quoteAmount - hookFee, 0);
        for (uint256 i; i < 256; ++i) {
            if (_buyStep(c, state, zeroForOne, limit)) return (state.out, hookFee, state.price);
        }
        revert InitialBuyNotFillable();
    }

    function _buyStep(T.LaunchConfig memory c, BuyState memory state, bool zeroForOne, uint160 limit)
        private
        pure
        returns (bool)
    {
        int24 next = zeroForOne ? (state.tick >> 8) << 8 : (((state.tick + 1) >> 8) << 8) + 255;
        if (next < c.tickLower) next = c.tickLower;
        if (next > c.tickUpper) next = c.tickUpper;
        uint160 nextPrice = TickMath.getSqrtPriceAtTick(next);
        uint256 spent;
        uint256 out;
        (state.price, spent, out,) = SwapMath.computeSwapStep(
            state.price,
            SwapMath.getSqrtPriceTarget(zeroForOne, nextPrice, limit),
            c.liquidity,
            -int256(state.remaining),
            0
        );
        state.remaining -= spent;
        state.out += out;
        if (state.remaining == 0) {
            if (state.out == 0) revert InitialBuyNotFillable();
            return true;
        }
        if (state.price == limit || next == (zeroForOne ? c.tickLower : c.tickUpper)) revert InitialBuyNotFillable();
        state.tick = zeroForOne ? next - 1 : next;
        return false;
    }
}
