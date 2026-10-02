// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VeylProjectDeployer} from "./VeylProjectDeployer.sol";

/// @dev Shared creation helper. Child authority is always bound to its caller.
contract VeylProjectBuilder {
    IPoolManager public immutable poolManager;
    mapping(address => address) public deployed;
    error InvalidConfiguration();
    error AlreadyCreated();

    constructor(IPoolManager manager_) {
        if (address(manager_).code.length == 0) revert InvalidConfiguration();
        poolManager = manager_;
    }

    function deploy(address protocol, address quoteAsset, address conversionSwapRouter)
        external
        returns (VeylProjectDeployer child)
    {
        if (deployed[msg.sender] != address(0)) revert AlreadyCreated();
        child = new VeylProjectDeployer{salt: bytes32(uint256(uint160(msg.sender)))}(
            msg.sender, protocol, address(poolManager), quoteAsset, conversionSwapRouter
        );
        deployed[msg.sender] = address(child);
    }
}
