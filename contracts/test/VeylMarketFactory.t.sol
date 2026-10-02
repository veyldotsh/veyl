// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {AgentToken, AgentTreasury} from "../src/AgentKit.sol";
import {RevenueRouter} from "../src/Funding.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";
import {VeylMarketFactory} from "../src/market/VeylMarketFactory.sol";
import {VeylLiquidityVault} from "../src/market/VeylLiquidityVault.sol";
import {VeylProjectDeployer} from "../src/market/VeylProjectDeployer.sol";
import {VeylMarketDeployer} from "../src/market/VeylMarketDeployer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {VeylMarketTypes as T} from "../src/market/VeylMarketTypes.sol";
import {VeylQuoter} from "../src/market/VeylQuoter.sol";
import {VeylProjectBuilder} from "../src/market/VeylProjectBuilder.sol";
import {VeylMarketBuilder} from "../src/market/VeylMarketBuilder.sol";
import {VeylLiquidityBuilder} from "../src/market/VeylLiquidityBuilder.sol";

abstract contract VeylMarketFixture is Test {
    using StateLibrary for IPoolManager;
    IPoolManager manager;
    VeylMarketFactory factory;
    VeylProjectBuilder projectBuilder;
    VeylMarketBuilder marketBuilder;
    VeylLiquidityBuilder liquidityBuilder;
    T.LaunchConfig config;
    bytes32 hookSalt;
    address constant PLATFORM = address(0x123456);
    address constant TREASURY_OWNER = address(0x654321);

    function _configure(IPoolManager manager_) internal {
        manager = manager_;
        projectBuilder = new VeylProjectBuilder(manager);
        marketBuilder = new VeylMarketBuilder(manager);
        liquidityBuilder = new VeylLiquidityBuilder(manager);
        factory = new VeylMarketFactory(
            manager,
            PLATFORM,
            new VeylQuoter(manager),
            address(0),
            address(0),
            projectBuilder,
            marketBuilder,
            liquidityBuilder
        );
        config = T.LaunchConfig({
            salt: keccak256("market fixture"),
            name: "Fixture only",
            symbol: "FIX",
            treasuryOwner: TREASURY_OWNER,
            operator: address(0xCAFE),
            dailyLimit: 0.1 ether,
            treasuryEth: 2 ether,
            buyFeeBps: 300,
            sellFeeBps: 300,
            lpFeePips: 0,
            tickSpacing: 200,
            sqrtPriceX96: 79228162514264337593543950336,
            tickLower: -600,
            tickUpper: 600,
            liquidity: 1000 ether,
            maxToken: 100 ether,
            maxQuote: 100 ether,
            minToken: 1,
            minQuote: 1,
            deadline: block.timestamp,
            launchProtection: false
        });
        hookSalt = _mine(address(this), config);
    }

    function _mine(address creator, T.LaunchConfig memory cfg) internal view returns (bytes32) {
        (bytes32 id,, bytes32 hash) = factory.predictLaunch(creator, cfg, bytes32(0));
        address deployer = address(factory.marketDeployer());
        for (uint256 i; i < 1_000_000; ++i) {
            bytes32 effective = keccak256(abi.encode(id, bytes32(i)));
            address candidate =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, effective, hash)))));
            if (uint160(candidate) & 0x3fff == 0x20cc) return bytes32(i);
        }
        revert("fixture salt search exhausted");
    }

    function _launch() internal returns (T.Market memory market) {
        (, market) = factory.launch{value: config.treasuryEth + config.maxQuote}(config, hookSalt);
    }

    function _assertAbsent(T.Market memory predicted) internal view {
        assertEq(predicted.token.code.length, 0);
        assertEq(predicted.treasury.code.length, 0);
        assertEq(predicted.revenueRouter.code.length, 0);
        assertEq(predicted.hook.code.length, 0);
        assertEq(predicted.swapRouter.code.length, 0);
        assertEq(predicted.liquidityVault.code.length, 0);
    }

    function _buySellFlush(T.Market memory market) internal {
        AgentToken token = AgentToken(market.token);
        VeylSwapRouter swapper = VeylSwapRouter(payable(market.swapRouter));
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        uint256 tokenBefore = token.balanceOf(address(this));
        uint256 ethBefore = address(this).balance;
        VeylQuoter.Quote memory quote =
            factory.quoter().quoteExactInput(hook, true, 1 ether, TickMath.MIN_SQRT_PRICE + 1);
        assertEq(hook.pendingFees(), 0);
        uint256 bought =
            swapper.buy{value: 1 ether}(1 ether, quote.amountOut, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        assertEq(bought, quote.amountOut);
        assertEq(ethBefore - address(this).balance, 1 ether);
        assertEq(token.balanceOf(address(this)), tokenBefore + bought);
        token.approve(address(swapper), 1 ether);
        ethBefore = address(this).balance;
        (uint256 spent, uint256 received) = swapper.sell(1 ether, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
        assertEq(spent, 1 ether);
        assertEq(address(this).balance - ethBefore, received);
        _flushAndDistribute(market, hook);
        assertEq(market.swapRouter.balance, 0);
    }

    function _flushAndDistribute(T.Market memory market, VeylFeeHook hook) internal {
        RevenueRouter revenue = RevenueRouter(payable(market.revenueRouter));
        uint256 fee = hook.pendingFees();
        assertGt(fee, 0);
        uint256 treasuryBefore = market.treasury.balance;
        uint256 creatorBefore = address(this).balance;
        uint256 platformBefore = PLATFORM.balance;
        assertEq(hook.flushFees(), fee);
        revenue.distribute(payable(market.treasury));
        revenue.distribute(payable(address(this)));
        revenue.distribute(payable(PLATFORM));
        assertEq(market.treasury.balance - treasuryBefore, fee * 7 / 10);
        assertEq(address(this).balance - creatorBefore, fee / 5);
        assertEq(PLATFORM.balance - platformBefore, fee - fee * 7 / 10 - fee / 5);
        assertEq(hook.flushFees(), 0);
    }

    receive() external payable {}
}

contract VeylMarketFactoryTest is VeylMarketFixture {
    using StateLibrary for IPoolManager;

    function setUp() public {
        _configure(IPoolManager(address(new PoolManager(address(this)))));
        vm.deal(address(this), 10_000 ether);
    }

    function testAtomicLaunchMatchesEveryPredictedAddressAndLocksLiquidity() public {
        (bytes32 id, T.Market memory predicted,) = factory.predictLaunch(address(this), config, hookSalt);
        uint256 beforeETH = address(this).balance;
        T.Market memory market = _launch();
        assertEq(abi.encode(market), abi.encode(predicted));
        assertEq(abi.encode(factory.getMarket(id)), abi.encode(market));
        AgentToken token = AgentToken(market.token);
        AgentTreasury treasury = AgentTreasury(payable(market.treasury));
        assertEq(treasury.owner(), TREASURY_OWNER);
        assertEq(treasury.operator(), config.operator);
        assertEq(treasury.dailyLimit(), config.dailyLimit);
        assertEq(market.treasury.balance, config.treasuryEth);
        assertEq(market.revenueRouter.balance, 0);
        assertEq(RevenueRouter(payable(market.revenueRouter)).creator(), address(this));
        assertEq(RevenueRouter(payable(market.revenueRouter)).protocol(), PLATFORM);
        assertEq(VeylFeeHook(payable(market.hook)).initializer(), address(factory));
        assertTrue(VeylFeeHook(payable(market.hook)).poolInitialized());
        assertEq(uint160(market.hook) & 0x3fff, 0x20cc);
        uint256 poolTokens = token.balanceOf(address(manager));
        assertGt(poolTokens, 0);
        assertEq(token.totalSupply(), factory.TOKEN_SUPPLY());
        assertEq(token.balanceOf(address(this)) + poolTokens, token.totalSupply());
        assertEq(token.balanceOf(market.liquidityVault), 0);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(beforeETH - address(this).balance, address(manager).balance + config.treasuryEth);
        assertEq(address(factory).balance, 0);
        assertEq(market.liquidityVault.balance, 0);
        (uint128 liquidity,,) = manager.getPositionInfo(
            PoolId.wrap(market.poolId), market.liquidityVault, config.tickLower, config.tickUpper, bytes32(0)
        );
        assertEq(liquidity, config.liquidity);
        assertEq(VeylLiquidityVault(market.liquidityVault).lockedLiquidity(), liquidity);
    }

    function testAtomicLaunchTradeAndFeeAllocation() public {
        _buySellFlush(_launch());
    }

    function testTokenOnlyLaunchCanAcceptFirstBuyBeforeETHSettlement() public {
        config.maxQuote = 0;
        config.minQuote = 0;
        config.tickUpper = -200;
        T.Market memory market = _launch();
        assertEq(address(manager).balance, 0);
        assertGt(IERC20(market.token).balanceOf(address(manager)), 0);
        VeylSwapRouter swapper = VeylSwapRouter(payable(market.swapRouter));
        uint256 beforeToken = IERC20(market.token).balanceOf(address(this));
        uint256 bought = swapper.buy{value: 1 ether}(1 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        assertGt(bought, 0);
        assertEq(IERC20(market.token).balanceOf(address(this)) - beforeToken, bought);
        assertEq(address(manager).balance, 1 ether);
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        assertEq(hook.pendingFees(), 0.03 ether);
        _flushAndDistribute(market, hook);
    }

    function testPredictionNamespacesEveryDeploymentByCreator() public view {
        (bytes32 firstId, T.Market memory first,) = factory.predictLaunch(address(this), config, hookSalt);
        (bytes32 secondId, T.Market memory second,) = factory.predictLaunch(address(0xBAD), config, hookSalt);
        assertNotEq(firstId, secondId);
        assertNotEq(first.token, second.token);
        assertNotEq(first.treasury, second.treasury);
        assertNotEq(first.revenueRouter, second.revenueRouter);
        assertNotEq(first.hook, second.hook);
        assertNotEq(first.swapRouter, second.swapRouter);
        assertNotEq(first.liquidityVault, second.liquidityVault);
        assertNotEq(first.poolId, second.poolId);
    }

    function testMissingInventoryAndExcessSupplyCannotLaunch() public {
        config.minToken = 0;
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        _launch();
        config.minToken = 1;
        config.maxToken = factory.TOKEN_SUPPLY() + 1;
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        _launch();
        VeylQuoter existingQuoter = factory.quoter();
        vm.expectRevert(VeylMarketFactory.InvalidConfiguration.selector);
        new VeylMarketFactory(
            manager, address(0), existingQuoter, address(0), address(0), projectBuilder, marketBuilder, liquidityBuilder
        );
    }

    function testSeedMinimumFailureRollsBackEveryDeploymentAndAllFunds() public {
        config.minQuote = 99 ether;
        (bytes32 id, T.Market memory predicted,) = factory.predictLaunch(address(this), config, hookSalt);
        uint256 beforeETH = address(this).balance;
        vm.expectRevert(VeylLiquidityVault.SeedBounds.selector);
        _launch();
        _assertAbsent(predicted);
        assertEq(factory.getMarket(id).token, address(0));
        assertEq(address(this).balance, beforeETH);
        assertEq(address(manager).balance, 0);
        config.minQuote = 1;
        _launch();
    }

    function testSeedMaximumFailureAndInvalidPriceAreAtomic() public {
        config.maxToken = 1;
        (, T.Market memory predicted,) = factory.predictLaunch(address(this), config, hookSalt);
        vm.expectRevert(VeylLiquidityVault.SeedBounds.selector);
        _launch();
        _assertAbsent(predicted);
        config.maxToken = 100 ether;
        config.sqrtPriceX96 = 1;
        vm.expectRevert();
        _launch();
        _assertAbsent(predicted);
    }

    function testInvalidHookPermissionSaltCannotLaunch() public {
        bytes32 bad = bytes32(uint256(hookSalt) + 1);
        (, T.Market memory predicted,) = factory.predictLaunch(address(this), config, bad);
        while (uint160(predicted.hook) & 0x3fff == 0x20cc) {
            bad = bytes32(uint256(bad) + 1);
            (, predicted,) = factory.predictLaunch(address(this), config, bad);
        }
        vm.expectRevert();
        factory.launch{value: 102 ether}(config, bad);
        _assertAbsent(predicted);
    }

    function testDuplicateAndFundingAndDeadlineChecks() public {
        vm.expectRevert(VeylMarketFactory.IncorrectFunding.selector);
        factory.launch{value: 101 ether}(config, hookSalt);
        vm.warp(config.deadline + 1);
        vm.expectRevert(VeylMarketFactory.Expired.selector);
        _launch();
        config.deadline = block.timestamp;
        _launch();
        vm.expectRevert(VeylMarketFactory.AlreadyLaunched.selector);
        _launch();
    }

    function testFactoryOnlyDeployersAndVaultCannotBeCalledOrWithdrawn() public {
        bytes32 id = factory.marketId(address(this), config.salt);
        VeylProjectDeployer projects = factory.projectDeployer();
        VeylMarketDeployer markets = factory.marketDeployer();
        vm.expectRevert(bytes4(keccak256("NotFactory()")));
        projects.deploy(id, address(this), config);
        vm.expectRevert(bytes4(keccak256("NotFactory()")));
        markets.deploy(id, hookSalt, address(1), address(2), config);
        T.Market memory market = _launch();
        VeylLiquidityVault vault = VeylLiquidityVault(market.liquidityVault);
        vm.expectRevert(VeylLiquidityVault.NotFactory.selector);
        vault.seed(1, 1, 0, 1, 0);
        vm.expectRevert(VeylLiquidityVault.AlreadySeeded.selector);
        vm.prank(address(factory));
        vault.seed(1, 1, 0, 1, 0);
        vm.expectRevert(VeylLiquidityVault.InvalidCallback.selector);
        vm.prank(address(manager));
        vault.unlockCallback("");
        (bool withdrew,) =
            market.liquidityVault.call(abi.encodeWithSignature("withdraw(address,uint256)", address(this), 1));
        assertFalse(withdrew);
        (bool removed,) = market.liquidityVault.call(abi.encodeWithSignature("removeLiquidity(uint128)", uint128(1)));
        assertFalse(removed);
        PoolKey memory key = VeylFeeHook(payable(market.hook)).getPoolKey();
        vm.expectRevert(VeylFeeHook.NotInitializer.selector);
        vm.prank(address(manager));
        VeylFeeHook(payable(market.hook)).beforeInitialize(address(this), key, config.sqrtPriceX96);
    }

    function testRefundReentryIsBlockedAndCreatorGetsOnlyUnspentInputs() public {
        MarketLaunchReceiver receiver = new MarketLaunchReceiver(factory);
        bytes32 salt = _mine(address(receiver), config);
        (, T.Market memory market) = receiver.launch{value: 102 ether}(config, salt, false);
        assertTrue(receiver.attempted());
        assertFalse(receiver.reentered());
        assertEq(receiver.failure(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertGt(address(receiver).balance, 0);
        assertEq(
            IERC20(market.token).balanceOf(address(receiver)) + IERC20(market.token).balanceOf(address(manager)),
            factory.TOKEN_SUPPLY()
        );
    }

    function testRejectedRefundRollsBackWholeLaunch() public {
        MarketLaunchReceiver receiver = new MarketLaunchReceiver(factory);
        bytes32 salt = _mine(address(receiver), config);
        (, T.Market memory predicted,) = factory.predictLaunch(address(receiver), config, salt);
        uint256 beforeETH = address(this).balance;
        vm.expectRevert(VeylLiquidityVault.RefundFailed.selector);
        receiver.launch{value: 102 ether}(config, salt, true);
        _assertAbsent(predicted);
        assertEq(address(this).balance, beforeETH);
    }

    function testFuzzSeedConservesETHAndFixedSupply(uint96 raw) public {
        config.liquidity = uint128(bound(raw, 1 ether, 2000 ether));
        uint256 beforeETH = address(this).balance;
        T.Market memory market = _launch();
        IERC20 token = IERC20(market.token);
        assertEq(token.balanceOf(address(this)) + token.balanceOf(address(manager)), factory.TOKEN_SUPPLY());
        assertEq(beforeETH - address(this).balance, address(manager).balance + config.treasuryEth);
        assertEq(address(factory).balance + market.liquidityVault.balance, 0);
    }
}

contract VeylAtomicMarketMainnetForkTest is VeylMarketFixture {
    function testPinnedMainnetAtomicLaunchBuySellAndPayout() public {
        vm.skip(!vm.envOr("VEYL_MAINNET_FORK", false));
        vm.createSelectFork("https://eth.drpc.org", 26_100_053);
        vm.deal(address(this), 10_000 ether);
        _configure(IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90));
        T.Market memory market = _launch();
        assertEq(block.chainid, 1);
        assertEq(block.number, 26_100_053);
        assertEq(market.treasury.balance, config.treasuryEth);
        assertTrue(VeylLiquidityVault(market.liquidityVault).seeded());
        _buySellFlush(market);
    }
}

contract MarketLaunchReceiver {
    VeylMarketFactory immutable factory;
    T.LaunchConfig private config;
    bytes32 private salt;
    bool private reject;
    bool public attempted;
    bool public reentered;
    bytes4 public failure;

    constructor(VeylMarketFactory factory_) {
        factory = factory_;
    }

    function launch(T.LaunchConfig calldata config_, bytes32 salt_, bool reject_)
        external
        payable
        returns (bytes32, T.Market memory)
    {
        config = config_;
        salt = salt_;
        reject = reject_;
        return factory.launch{value: msg.value}(config_, salt_);
    }

    receive() external payable {
        require(!reject, "refund rejected");
        attempted = true;
        bytes memory reason;
        (reentered, reason) = address(factory).call(abi.encodeCall(VeylMarketFactory.launch, (config, salt)));
        failure = bytes4(reason);
    }
}
