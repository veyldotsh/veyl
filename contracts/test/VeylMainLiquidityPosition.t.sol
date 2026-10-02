// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VeylMarketFixture} from "./VeylMarketFactory.t.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {AgentToken} from "../src/AgentKit.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";
import {VeylMarketTypes as T} from "../src/market/VeylMarketTypes.sol";
import {VeylMarketFactory} from "../src/market/VeylMarketFactory.sol";
import {VeylProjectBuilder} from "../src/market/VeylProjectBuilder.sol";
import {VeylMarketBuilder} from "../src/market/VeylMarketBuilder.sol";
import {VeylLiquidityBuilder} from "../src/market/VeylLiquidityBuilder.sol";
import {VeylQuoter} from "../src/market/VeylQuoter.sol";
import {VeylMainLiquidityBuilder} from "../src/market/VeylMainLiquidityBuilder.sol";
import {VeylMainLiquidityDeployer} from "../src/market/VeylMainLiquidityDeployer.sol";
import {VeylMainLiquidityPosition, IVeylPositionManager} from "../src/market/VeylMainLiquidityPosition.sol";

interface IPositionNFT is IVeylPositionManager {
    function approve(address spender, uint256 id) external;
    function getApproved(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
}

interface IPermitAllowance {
    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48);
}

contract VeylMainLaunchMathTest is Test {
    function testApprovedBoundaryAndMinimalRoundedUpLiquidity() public {
        VeylQuoter quoter = new VeylQuoter(IPoolManager(address(new PoolManager(address(this)))));
        uint160 price = 1771577727172025373304338615273325;
        uint128 liquidity = 43827373799693085948824;
        assertEq(price, TickMath.getSqrtPriceAtTick(200311));
        (uint256 ethUsed, uint256 tokensUsed) = quoter.previewSeed(price, -887272, 200311, liquidity);
        assertEq(ethUsed, 0);
        assertEq(tokensUsed, 980000000000000000000012538);
        assertEq(tokensUsed - 980_000_000 ether, 12538);
        (, uint256 below) = quoter.previewSeed(price, -887272, 200311, liquidity - 1);
        assertLt(below, 980_000_000 ether);
        assertEq(1_000_000_000 ether - tokensUsed, 19999999999999999999987462);
    }
}

contract VeylMainPositionMainnetForkTest is VeylMarketFixture {
    using StateLibrary for IPoolManager;
    IPositionNFT constant POSM = IPositionNFT(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant TRADER = address(0xB0B);
    address constant DEAD = address(0xdEaD);
    uint256 constant LIMIT = 20_000_000 ether;
    bytes32 constant MAIN_SALT = keccak256("veyl:ethereum:main-token:v1");

    function _mainSetup() internal {
        vm.skip(!vm.envOr("VEYL_MAINNET_FORK", false));
        vm.createSelectFork("https://eth.drpc.org", 26_100_053);
        manager = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
        assertEq(address(POSM.poolManager()), address(manager));
        assertEq(POSM.permit2(), PERMIT2);
        projectBuilder = new VeylProjectBuilder(manager);
        marketBuilder = new VeylMarketBuilder(manager);
        VeylMainLiquidityBuilder mainBuilder = new VeylMainLiquidityBuilder(manager, POSM, address(this), MAIN_SALT);
        factory = new VeylMarketFactory(
            manager,
            PLATFORM,
            new VeylQuoter(manager),
            address(0),
            address(0),
            projectBuilder,
            marketBuilder,
            VeylLiquidityBuilder(address(mainBuilder))
        );
        config = T.LaunchConfig({
            salt: MAIN_SALT,
            name: "Veyl",
            symbol: "VEYL",
            treasuryOwner: address(this),
            operator: address(0),
            dailyLimit: 0,
            treasuryEth: 0,
            buyFeeBps: 180,
            sellFeeBps: 180,
            lpFeePips: 0,
            tickSpacing: 1,
            sqrtPriceX96: 1771577727172025373304338615273325,
            tickLower: -887272,
            tickUpper: 200311,
            liquidity: 43827373799693085948824,
            maxToken: 980000000000000000000012538,
            maxQuote: 0,
            minToken: 980_000_000 ether,
            minQuote: 0,
            deadline: block.timestamp,
            launchProtection: true
        });
        hookSalt = _mine(address(this), config);
    }

    function testCanonicalPositionManagerMintsDirectlyToCreatorWithZeroETHAndBoundedDust() public {
        _mainSetup();
        (, T.Market memory predicted,) = factory.predictLaunch(address(this), config, hookSalt);
        uint256 next = POSM.nextTokenId();
        uint256 managerEthBefore = address(manager).balance;
        T.Market memory market = _launch();
        assertEq(abi.encode(market), abi.encode(predicted));
        VeylMainLiquidityPosition position = VeylMainLiquidityPosition(market.liquidityVault);
        AgentToken token = AgentToken(market.token);
        assertEq(position.positionId(), next);
        assertEq(POSM.ownerOf(next), address(this));
        assertEq(address(position.positionManager()), address(POSM));
        assertEq(position.seededTokens(), config.maxToken);
        assertEq(POSM.getPositionLiquidity(next), config.liquidity);
        (uint128 coreLiquidity,,) = manager.getPositionInfo(
            PoolId.wrap(market.poolId), address(POSM), config.tickLower, config.tickUpper, bytes32(next)
        );
        assertEq(coreLiquidity, config.liquidity);
        assertEq(address(manager).balance, managerEthBefore);
        assertEq(token.balanceOf(address(manager)), config.maxToken);
        assertEq(token.balanceOf(address(this)), 19999999999999999999987462);
        assertEq(
            token.balanceOf(address(factory)) + token.balanceOf(address(position)) + token.balanceOf(address(POSM))
                + token.balanceOf(PERMIT2),
            0
        );
        assertTrue(token.activated());
        assertTrue(token.launchLimitsActive());
        assertEq(token.bootstrapVault(), address(position));
        assertEq(token.allowance(address(position), PERMIT2), 0);
        (uint160 permitted,,) = IPermitAllowance(PERMIT2).allowance(address(position), address(token), address(POSM));
        assertEq(permitted, 0);
        vm.expectRevert(VeylMainLiquidityPosition.NotFactory.selector);
        position.seed(config.liquidity, config.maxToken, 0, config.minToken, 0);
        vm.expectRevert(VeylMainLiquidityPosition.AlreadySeeded.selector);
        vm.prank(address(factory));
        position.seed(config.liquidity, config.maxToken, 0, config.minToken, 0);
    }

    function testFirstBuySellETHFeesAndManualNFTTransferToDeadPreserveLiquidity() public {
        _mainSetup();
        T.Market memory market = _launch();
        AgentToken token = AgentToken(market.token);
        VeylFeeHook hook = VeylFeeHook(payable(market.hook));
        VeylSwapRouter swapper = VeylSwapRouter(payable(market.swapRouter));
        VeylMainLiquidityPosition position = VeylMainLiquidityPosition(market.liquidityVault);
        vm.deal(TRADER, 10 ether);
        uint256 gasBefore = gasleft();
        vm.prank(TRADER);
        uint256 bought = swapper.buy{value: 0.01 ether}(0.01 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        emit log_named_uint("First 0.01 ETH buy gas", gasBefore - gasleft());
        assertGt(bought, 0);
        assertLt(bought, LIMIT);
        assertEq(hook.pendingFees(), 0.01 ether * 180 / 10000);
        vm.prank(TRADER);
        token.approve(address(swapper), bought);
        vm.prank(TRADER);
        (uint256 sold, uint256 received) = swapper.sell(bought, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
        assertEq(sold, bought);
        assertGt(received, 0);
        _flushAndDistribute(market, hook);
        uint256 id = position.positionId();
        POSM.approve(TRADER, id);
        POSM.transferFrom(address(this), DEAD, id);
        assertEq(POSM.ownerOf(id), DEAD);
        assertEq(POSM.getApproved(id), address(0));
        assertEq(POSM.getPositionLiquidity(id), config.liquidity);
        vm.expectRevert();
        POSM.transferFrom(DEAD, address(this), id);
        vm.expectRevert();
        vm.prank(TRADER);
        POSM.transferFrom(DEAD, TRADER, id);
        vm.roll(block.number + 10);
        gasBefore = gasleft();
        vm.prank(TRADER);
        swapper.buy{value: 1 ether}(1 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        emit log_named_uint("Post-protection 1 ETH buy gas", gasBefore - gasleft());
        assertEq(POSM.ownerOf(id), DEAD);
    }

    function testCanonicalSeedDoesNotWeakenTenBlockTransactionAndWalletCaps() public {
        _mainSetup();
        T.Market memory market = _launch();
        AgentToken token = AgentToken(market.token);
        VeylSwapRouter swapper = VeylSwapRouter(payable(market.swapRouter));
        vm.deal(TRADER, 1 ether);
        vm.expectRevert();
        vm.prank(TRADER);
        swapper.buy{value: 0.1 ether}(0.1 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        vm.deal(address(this), 1 ether);
        vm.expectRevert();
        swapper.buy{value: 0.001 ether}(0.001 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        uint256 start = block.number;
        for (uint256 i; i < 10; ++i) {
            vm.roll(start + i);
            vm.expectRevert(AgentToken.MaxTransactionExceeded.selector);
            vm.prank(address(manager));
            token.transfer(TRADER, LIMIT + 1);
        }
        vm.prank(address(manager));
        token.transfer(TRADER, LIMIT);
        assertEq(token.balanceOf(TRADER), LIMIT);
        vm.expectRevert(AgentToken.MaxWalletExceeded.selector);
        token.transfer(TRADER, 1);
        vm.prank(TRADER);
        token.transfer(address(manager), LIMIT);
        vm.roll(start + 10);
        vm.prank(address(manager));
        token.transfer(TRADER, LIMIT + 1);
        assertEq(token.balanceOf(TRADER), LIMIT + 1);
    }

    function testCreatorOwnsWithdrawableNFTUntilItsManualDeadTransfer() public {
        _mainSetup();
        T.Market memory market = _launch();
        uint256 id = VeylMainLiquidityPosition(market.liquidityVault).positionId();
        vm.roll(block.number + 10);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint256(config.liquidity), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(Currency.wrap(address(0)), Currency.wrap(market.token), address(this));
        uint256 beforeTokens = IERC20(market.token).balanceOf(address(this));
        POSM.modifyLiquidities(
            abi.encode(abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR)), params),
            block.timestamp
        );
        assertEq(POSM.getPositionLiquidity(id), 0);
        assertGt(IERC20(market.token).balanceOf(address(this)), beforeTokens + 979_999_999 ether);
        assertEq(POSM.ownerOf(id), address(this));
    }

    function testMainOnlyDeployerRejectsOtherLaunchTermsAndForeignPositionManager() public {
        _mainSetup();
        VeylMainLiquidityDeployer child = VeylMainLiquidityDeployer(address(factory.liquidityDeployer()));
        bytes32 id = factory.marketId(address(this), config.salt);
        vm.expectRevert(VeylMainLiquidityDeployer.NotFactory.selector);
        child.deploy(id, address(0), address(this), config);
        vm.expectRevert(VeylMainLiquidityDeployer.InvalidMainLaunch.selector);
        child.predict(id, address(0), TRADER, config);
        config.launchProtection = false;
        vm.expectRevert(VeylMainLiquidityDeployer.InvalidMainLaunch.selector);
        child.predict(id, address(0), address(this), config);
        config.launchProtection = true;
        config.symbol = "AGENT";
        vm.expectRevert(VeylMainLiquidityDeployer.InvalidMainLaunch.selector);
        child.predict(id, address(0), address(this), config);
        config.symbol = "VEYL";
        config.maxToken = 980_000_000 ether + 1_000_001;
        vm.expectRevert(VeylMainLiquidityDeployer.InvalidMainLaunch.selector);
        child.predict(id, address(0), address(this), config);
        config.maxToken = 980000000000000000000012538;
        config.tickSpacing = 200;
        vm.expectRevert(VeylMainLiquidityDeployer.InvalidMainLaunch.selector);
        child.predict(id, address(0), address(this), config);
        vm.expectRevert(VeylMainLiquidityBuilder.InvalidConfiguration.selector);
        new VeylMainLiquidityBuilder(manager, IVeylPositionManager(TRADER), address(this), MAIN_SALT);
    }
}
