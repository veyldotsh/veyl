// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {AgentToken, AgentTreasury} from "../src/AgentKit.sol";
import {RevenueRouter} from "../src/Funding.sol";
import {VeylFeeHook} from "../src/hook/VeylFeeHook.sol";
import {VeylSwapRouter} from "../src/VeylSwapRouter.sol";

/// @notice Opt-in read-only RPC fork. All deployments and trades exist only inside the test VM.
contract VeylFeeHookMainnetForkTest is Test {
    uint256 constant FORK_BLOCK = 26_100_053;
    address constant MAINNET_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function testPinnedMainnetManagerBuySellFlush() public {
        vm.skip(!vm.envOr("VEYL_MAINNET_FORK", false));
        vm.createSelectFork("https://eth.drpc.org", FORK_BLOCK);
        assertEq(block.chainid, 1);
        assertEq(block.number, FORK_BLOCK);
        assertGt(MAINNET_MANAGER.code.length, 0);
        // Funding inside the test frame avoids Foundry's fork-backed EOA balance quirk.
        vm.deal(address(this), 1000 ether);
        IPoolManager manager = IPoolManager(MAINNET_MANAGER);
        AgentToken token = new AgentToken("Fork-only fixture", "FORK", address(this), false, address(0));
        AgentTreasury treasury = new AgentTreasury(address(this), address(0), 0);
        ForkFeeReceiver creator = new ForkFeeReceiver();
        ForkFeeReceiver platform = new ForkFeeReceiver();
        RevenueRouter router = new RevenueRouter(address(treasury), address(creator), address(platform));
        // Fixture-only fees; no launch rates are adopted by this test.
        address location = address(uint160(0x7654321000000000000000000000000000000000) | FLAGS);
        assertEq(location.code.length, 0);
        deployCodeTo(
            "VeylFeeHook.sol:VeylFeeHook",
            abi.encode(
                manager,
                address(token),
                router,
                address(this),
                uint16(250),
                uint16(375),
                uint24(3000),
                int24(60),
                address(0)
            ),
            location
        );
        VeylFeeHook hook = VeylFeeHook(payable(location));
        PoolKey memory key = hook.getPoolKey();
        manager.initialize(key, 79228162514264337593543950336);
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(manager);
        VeylSwapRouter swapper = new VeylSwapRouter(hook);
        token.approve(address(liquidity), type(uint256).max);
        token.approve(address(swapper), type(uint256).max);
        liquidity.modifyLiquidity{value: 100 ether}(key, ModifyLiquidityParams(-600, 600, 1000 ether, bytes32(0)), "");
        _tradeBothDirections(swapper, token);
        uint256 owed = hook.pendingFees();
        assertGt(owed, 0.025 ether);
        uint256 managerBefore = MAINNET_MANAGER.balance;
        assertEq(hook.flushFees(), owed);
        assertEq(hook.pendingFees(), 0);
        assertEq(managerBefore - MAINNET_MANAGER.balance, owed);
        assertEq(address(router).balance, owed);
        _distributeAndCheck(router, address(treasury), address(creator), address(platform), owed);
        assertEq(hook.flushFees(), 0);
    }

    function _distributeAndCheck(
        RevenueRouter router,
        address treasury,
        address creator,
        address platform,
        uint256 owed
    ) internal {
        // A deterministic test address can already hold dust on the pinned chain.
        uint256 treasuryBefore = treasury.balance;
        uint256 creatorBefore = creator.balance;
        uint256 platformBefore = platform.balance;
        router.distribute(payable(treasury));
        router.distribute(payable(creator));
        router.distribute(payable(platform));
        assertEq(treasury.balance - treasuryBefore, owed * 7 / 10);
        assertEq(creator.balance - creatorBefore, owed / 5);
        assertEq(platform.balance - platformBefore, owed - owed * 7 / 10 - owed / 5);
        assertEq(address(router).balance, 0);
    }

    function _tradeBothDirections(VeylSwapRouter swapper, AgentToken token) internal {
        uint256 tokenBefore = token.balanceOf(address(this));
        uint256 ethBefore = address(this).balance;
        uint256 bought = swapper.buy{value: 1 ether}(1 ether, 1, TickMath.MIN_SQRT_PRICE + 1, block.timestamp);
        assertGt(bought, 0);
        assertEq(token.balanceOf(address(this)) - tokenBefore, bought);
        assertEq(ethBefore - address(this).balance, 1 ether);
        ethBefore = address(this).balance;
        (uint256 spent, uint256 received) = swapper.sell(1 ether, 1, TickMath.MAX_SQRT_PRICE - 1, block.timestamp);
        assertEq(spent, 1 ether);
        assertGt(received, 0);
        assertEq(token.balanceOf(address(this)), tokenBefore + bought - spent);
        assertEq(address(this).balance - ethBefore, received);
        assertEq(address(swapper).balance, 0);
        assertEq(token.balanceOf(address(swapper)), 0);
    }

    receive() external payable {}
}

contract ForkFeeReceiver {
    receive() external payable {}
}
