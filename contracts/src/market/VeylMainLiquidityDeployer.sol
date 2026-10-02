// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VeylFeeHook} from "../hook/VeylFeeHook.sol";
import {VeylMainLiquidityPosition, IVeylPositionManager} from "./VeylMainLiquidityPosition.sol";
import {VeylMarketTypes as T} from "./VeylMarketTypes.sol";

/// @notice Explicit main-token launch policy, separate from the agent vault deployer.
contract VeylMainLiquidityDeployer {
    address public immutable factory;
    IPoolManager public immutable poolManager;
    IVeylPositionManager public immutable positionManager;
    address public immutable mainCreator;
    bytes32 public immutable mainLaunchSalt;
    error NotFactory();
    error InvalidMainLaunch();

    constructor(
        address factory_,
        IPoolManager manager_,
        IVeylPositionManager positionManager_,
        address creator_,
        bytes32 salt_
    ) {
        factory = factory_;
        poolManager = manager_;
        positionManager = positionManager_;
        mainCreator = creator_;
        mainLaunchSalt = salt_;
    }

    function _check(bytes32 id, address creator, T.LaunchConfig calldata config) private view {
        if (
            creator != mainCreator || config.salt != mainLaunchSalt
                || id != keccak256(abi.encode(creator, mainLaunchSalt))
                || keccak256(bytes(config.name)) != keccak256("Veyl")
                || keccak256(bytes(config.symbol)) != keccak256("VEYL") || config.treasuryOwner != mainCreator
                || config.buyFeeBps != 180 || config.sellFeeBps != 180 || config.lpFeePips != 0
                || config.tickSpacing != 1 || config.tickLower != -887272 || config.tickUpper != 200311
                || config.sqrtPriceX96 != 1771577727172025373304338615273325 || !config.launchProtection
                || config.maxQuote != 0 || config.minQuote != 0 || config.minToken != 980_000_000 ether
                || config.maxToken < config.minToken || config.maxToken > 980_000_000 ether + 1_000_000
        ) revert InvalidMainLaunch();
    }

    function deploy(bytes32 id, address hook, address creator, T.LaunchConfig calldata config)
        external
        returns (address position)
    {
        if (msg.sender != factory) revert NotFactory();
        _check(id, creator, config);
        if (
            VeylFeeHook(payable(hook)).quoteAsset() != address(0)
                || address(VeylFeeHook(payable(hook)).poolManager()) != address(poolManager)
        ) revert InvalidMainLaunch();
        position = address(
            new VeylMainLiquidityPosition{salt: id}(
                factory, VeylFeeHook(payable(hook)), creator, config.tickLower, config.tickUpper, positionManager
            )
        );
    }

    function predict(bytes32 id, address hook, address creator, T.LaunchConfig calldata config)
        external
        view
        returns (address)
    {
        _check(id, creator, config);
        bytes32 hash = keccak256(
            abi.encodePacked(
                type(VeylMainLiquidityPosition).creationCode,
                abi.encode(factory, hook, creator, config.tickLower, config.tickUpper, positionManager)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), id, hash)))));
    }
}
