// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VeylFeeHook} from "../hook/VeylFeeHook.sol";
import {VeylLiquidityVault} from "./VeylLiquidityVault.sol";
import {VeylMarketTypes as T} from "./VeylMarketTypes.sol";

/// @dev Factory-only vault creation module. It never holds assets or permissions.
contract VeylLiquidityDeployer {
    address public immutable factory;
    IPoolManager public immutable poolManager;
    error NotFactory();

    constructor(address factory_, IPoolManager manager_) {
        factory = factory_;
        poolManager = manager_;
    }

    function deploy(bytes32 id, address hook, address creator, T.LaunchConfig calldata config)
        external
        returns (address vault)
    {
        if (msg.sender != factory) revert NotFactory();
        vault = address(
            new VeylLiquidityVault{salt: id}(
                factory,
                VeylFeeHook(payable(hook)),
                creator,
                config.tickLower,
                config.tickUpper,
                config.launchProtection
            )
        );
    }

    function predict(bytes32 id, address hook, address creator, T.LaunchConfig calldata config)
        external
        view
        returns (address)
    {
        bytes32 hash = keccak256(
            abi.encodePacked(
                type(VeylLiquidityVault).creationCode,
                abi.encode(factory, hook, creator, config.tickLower, config.tickUpper, config.launchProtection)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), id, hash)))));
    }
}
