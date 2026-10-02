// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VeylLiquidityDeployer} from "./VeylLiquidityDeployer.sol";

contract VeylLiquidityBuilder {
    IPoolManager public immutable poolManager;
    mapping(address => address) public deployed;
    error InvalidConfiguration();
    error AlreadyCreated();

    constructor(IPoolManager manager_) {
        if (address(manager_).code.length == 0) revert InvalidConfiguration();
        poolManager = manager_;
    }

    function deploy() external returns (VeylLiquidityDeployer child) {
        if (deployed[msg.sender] != address(0)) revert AlreadyCreated();
        child = new VeylLiquidityDeployer{salt: bytes32(uint256(uint160(msg.sender)))}(msg.sender, poolManager);
        deployed[msg.sender] = address(child);
    }
}
