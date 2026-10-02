// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library VeylMarketTypes {
    /// @dev Every financial parameter is explicit. No sample fee or liquidity policy is adopted here.
    struct LaunchConfig {
        bytes32 salt;
        string name;
        string symbol;
        address treasuryOwner;
        address operator;
        uint256 dailyLimit;
        uint256 treasuryEth;
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        uint24 lpFeePips;
        int24 tickSpacing;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 maxToken;
        uint256 maxQuote;
        uint256 minToken;
        uint256 minQuote;
        uint256 deadline;
        bool launchProtection;
    }

    struct Market {
        address creator;
        address treasuryOwner;
        address token;
        address treasury;
        address revenueRouter;
        address hook;
        address swapRouter;
        address liquidityVault;
        bytes32 poolId;
        address quoteAsset;
    }
}
