// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VeylMarketFixture} from "./VeylMarketFactory.t.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {AgentToken} from "../src/AgentKit.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";
import {VeylQuoter} from "../src/market/VeylQuoter.sol";
import {VeylMarketTypes as T} from "../src/market/VeylMarketTypes.sol";

contract VeylQuoterTest is VeylMarketFixture {
    T.Market market;
    VeylQuoter quoter;
    VeylFeeHook hook;
    VeylSwapRouter swapper;
    AgentToken token;

    function setUp() public {
        _configure(IPoolManager(address(new PoolManager(address(this)))));
        vm.deal(address(this), 10_000 ether);
        market = _launch();
        quoter = factory.quoter();
        hook = VeylFeeHook(payable(market.hook));
        swapper = VeylSwapRouter(payable(market.swapRouter));
        token = AgentToken(market.token);
    }

    function testBuyQuoteMatchesExecutionIncludingETHHookFeeAndPrice() public {
        (uint160 initialPrice, int24 initialTick, uint128 initialLiquidity) = quoter.getPoolState(hook);
        uint256 managerETH = address(manager).balance;
        uint256 tokens = token.balanceOf(address(this));
        VeylQuoter.Quote memory quote = quoter.quoteExactInput(hook, true, 1 ether, TickMath.MIN_SQRT_PRICE + 1);
        assertEq(quote.amountIn, 1 ether);
        assertEq(quote.hookFee, 0.03 ether);
        assertGt(quote.amountOut, 0);
        assertEq(address(manager).balance, managerETH);
        assertEq(token.balanceOf(address(this)), tokens);
        assertEq(hook.pendingFees(), 0);
        (uint160 price, int24 tick, uint128 liquidity) = quoter.getPoolState(hook);
        assertEq(price, initialPrice);
        assertEq(tick, initialTick);
        assertEq(liquidity, initialLiquidity);
        uint256 received =
            swapper.buy{value: 1 ether}(1 ether, quote.amountOut, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        assertEq(received, quote.amountOut);
        assertEq(hook.pendingFees(), quote.hookFee);
        (price, tick, liquidity) = quoter.getPoolState(hook);
        assertEq(price, quote.sqrtPriceX96After);
        assertEq(tick, quote.tickAfter);
        assertEq(liquidity, quote.liquidityAfter);
    }

    function testSellQuoteNeedsNoBalanceOrApprovalAndMatchesNetOutput() public {
        vm.prank(address(0xDEAD));
        VeylQuoter.Quote memory quote = quoter.quoteExactInput(hook, false, 1 ether, TickMath.MAX_SQRT_PRICE - 1);
        assertEq(token.allowance(address(this), address(quoter)), 0);
        assertEq(hook.pendingFees(), 0);
        assertEq(quote.hookFee, (quote.amountOut + quote.hookFee) * 300 / 10_000);
        token.approve(address(swapper), 1 ether);
        (uint256 spent, uint256 output) =
            swapper.sell(1 ether, quote.amountOut, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
        assertEq(spent, quote.amountIn);
        assertEq(output, quote.amountOut);
        assertEq(hook.pendingFees(), quote.hookFee);
    }

    function testPartialSellQuoteMatchesActualConsumedInput() public {
        uint160 limit = TickMath.getSqrtPriceAtTick(1);
        VeylQuoter.Quote memory quote = quoter.quoteExactInput(hook, false, 10 ether, limit);
        assertLt(quote.amountIn, 10 ether);
        assertGt(quote.amountIn, 0);
        token.approve(address(swapper), 10 ether);
        (uint256 spent, uint256 output) = swapper.sell(10 ether, quote.amountOut, limit, block.timestamp);
        assertEq(spent, quote.amountIn);
        assertEq(output, quote.amountOut);
    }

    function testPartialBuyQuoteFailsWithoutChangingPoolOrClaims() public {
        (uint160 price, int24 tick, uint128 liquidity) = quoter.getPoolState(hook);
        vm.expectRevert();
        quoter.quoteExactInput(hook, true, 10 ether, TickMath.getSqrtPriceAtTick(-1));
        (uint160 afterPrice, int24 afterTick, uint128 afterLiquidity) = quoter.getPoolState(hook);
        assertEq(afterPrice, price);
        assertEq(afterTick, tick);
        assertEq(afterLiquidity, liquidity);
        assertEq(hook.pendingFees(), 0);
        quoter.quoteExactInput(hook, true, 1 ether, TickMath.MIN_SQRT_PRICE + 1);
    }

    function testQuotesCannotBeUsedAsCallbacksOrFundTransfers() public {
        vm.expectRevert(VeylQuoter.InvalidCallback.selector);
        quoter.unlockCallback("");
        vm.expectRevert(VeylQuoter.InvalidCallback.selector);
        vm.prank(address(manager));
        quoter.unlockCallback("");
        (bool paid,) = address(quoter).call{value: 1}("");
        assertFalse(paid);
        vm.expectRevert(VeylQuoter.InvalidAmount.selector);
        quoter.quoteExactInput(hook, true, 0, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(VeylQuoter.InvalidAmount.selector);
        quoter.quoteExactInput(hook, true, uint256(uint128(type(int128).max)) + 1, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(VeylQuoter.InvalidConfiguration.selector);
        new VeylQuoter(IPoolManager(address(0)));
    }

    function testRepeatedQuotesDoNotAccumulateFees() public {
        VeylQuoter.Quote memory first = quoter.quoteExactInput(hook, true, 1 ether, TickMath.MIN_SQRT_PRICE + 1);
        VeylQuoter.Quote memory second = quoter.quoteExactInput(hook, true, 1 ether, TickMath.MIN_SQRT_PRICE + 1);
        assertEq(abi.encode(first), abi.encode(second));
        assertEq(hook.pendingFees(), 0);
        assertEq(address(quoter).balance, 0);
        assertEq(token.balanceOf(address(quoter)), 0);
    }

    function testSeedPreviewExactlyMatchesInitialPosition() public view {
        (uint256 eth, uint256 tokens) =
            quoter.previewSeed(config.sqrtPriceX96, config.tickLower, config.tickUpper, config.liquidity);
        assertEq(eth, address(manager).balance);
        assertEq(tokens, token.balanceOf(address(manager)));
        (uint128 affordable, uint256 ethUsed, uint256 tokensUsed) = quoter.previewLiquidity(
            config.sqrtPriceX96, config.tickLower, config.tickUpper, config.maxQuote, config.maxToken
        );
        assertGt(affordable, config.liquidity);
        assertLe(ethUsed, config.maxQuote);
        assertLe(tokensUsed, config.maxToken);
    }

    function testSingleSidedSeedPreviewsAndInvalidBounds() public {
        (uint256 eth, uint256 tokens) = quoter.previewSeed(config.sqrtPriceX96, -600, -200, config.liquidity);
        assertEq(eth, 0);
        assertGt(tokens, 0);
        (eth, tokens) = quoter.previewSeed(config.sqrtPriceX96, 200, 600, config.liquidity);
        assertGt(eth, 0);
        assertEq(tokens, 0);
        vm.expectRevert(VeylQuoter.InvalidConfiguration.selector);
        quoter.previewSeed(1, -600, 600, config.liquidity);
        vm.expectRevert(VeylQuoter.InvalidAmount.selector);
        quoter.previewSeed(config.sqrtPriceX96, -600, 600, 0);
    }

    function testFuzzQuoteEqualsExecutedBuy(uint96 value) public {
        uint256 amount = bound(value, 1000, 1 ether);
        VeylQuoter.Quote memory quote = quoter.quoteExactInput(hook, true, amount, TickMath.MIN_SQRT_PRICE + 1);
        uint256 actual =
            swapper.buy{value: amount}(amount, quote.amountOut, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        assertEq(actual, quote.amountOut);
        assertEq(hook.pendingFees(), quote.hookFee);
    }
}
