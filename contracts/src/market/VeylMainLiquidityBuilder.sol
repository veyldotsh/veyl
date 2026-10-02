// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VeylMainLiquidityDeployer} from "./VeylMainLiquidityDeployer.sol";
import {IVeylPositionManager} from "./VeylMainLiquidityPosition.sol";

/// @notice Main-only replacement for the liquidity builder constructor argument.
/// Agent market factories continue to use VeylLiquidityBuilder unchanged.
contract VeylMainLiquidityBuilder {
    IPoolManager public immutable poolManager;
    IVeylPositionManager public immutable positionManager;
    address public immutable mainCreator;
    bytes32 public immutable mainLaunchSalt;
    mapping(address => address) public deployed;
    error InvalidConfiguration();
    error AlreadyCreated();

    constructor(IPoolManager manager_, IVeylPositionManager positionManager_, address creator_, bytes32 salt_) {
        if (
            address(manager_).code.length == 0
                || address(positionManager_) != 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e
                || address(positionManager_).code.length == 0
                || address(positionManager_.poolManager()) != address(manager_) || creator_ == address(0)
                || salt_ == bytes32(0)
        ) revert InvalidConfiguration();
        poolManager = manager_;
        positionManager = positionManager_;
        mainCreator = creator_;
        mainLaunchSalt = salt_;
    }

    function deploy() external returns (VeylMainLiquidityDeployer child) {
        if (deployed[msg.sender] != address(0)) revert AlreadyCreated();
        child = new VeylMainLiquidityDeployer{salt: bytes32(uint256(uint160(msg.sender)))}(
            msg.sender, poolManager, positionManager, mainCreator, mainLaunchSalt
        );
        deployed[msg.sender] = address(child);
    }
}
