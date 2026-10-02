// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VeylFeeHook} from "../hook/VeylFeeHook.sol";
import {RevenueRouter} from "../Funding.sol";
import {VeylSwapRouter} from "../VeylSwapRouter.sol";
import {VeylMarketTypes as T} from "./VeylMarketTypes.sol";

contract VeylMarketDeployer {
    address public immutable factory;
    IPoolManager public immutable poolManager;
    address public immutable quoteAsset;
    error NotFactory();

    constructor(address factory_, IPoolManager manager_, address quoteAsset_) {
        factory = factory_;
        poolManager = manager_;
        quoteAsset = quoteAsset_;
    }

    function deploy(bytes32 id, bytes32 hookSalt, address token, address revenueRouter, T.LaunchConfig calldata config)
        external
        returns (address hook, address swapRouter)
    {
        if (msg.sender != factory) revert NotFactory();
        hook = address(
            new VeylFeeHook{salt: namespacedSalt(id, hookSalt)}(
                poolManager,
                token,
                RevenueRouter(payable(revenueRouter)),
                factory,
                config.buyFeeBps,
                config.sellFeeBps,
                config.lpFeePips,
                config.tickSpacing,
                quoteAsset
            )
        );
        swapRouter = address(new VeylSwapRouter{salt: id}(VeylFeeHook(payable(hook))));
    }

    function hookInitCodeHash(address token, address revenueRouter, T.LaunchConfig calldata config)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                type(VeylFeeHook).creationCode,
                abi.encode(
                    poolManager,
                    token,
                    RevenueRouter(payable(revenueRouter)),
                    factory,
                    config.buyFeeBps,
                    config.sellFeeBps,
                    config.lpFeePips,
                    config.tickSpacing,
                    quoteAsset
                )
            )
        );
    }

    function namespacedSalt(bytes32 id, bytes32 hookSalt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, hookSalt));
    }

    function predict(bytes32 id, bytes32 hookSalt, address token, address revenueRouter, T.LaunchConfig calldata config)
        external
        view
        returns (address hook, address swapRouter, bytes32 initCodeHash)
    {
        initCodeHash = hookInitCodeHash(token, revenueRouter, config);
        hook = _predict(namespacedSalt(id, hookSalt), initCodeHash);
        swapRouter = _predict(id, keccak256(abi.encodePacked(type(VeylSwapRouter).creationCode, abi.encode(hook))));
    }

    function _predict(bytes32 salt, bytes32 hash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, hash)))));
    }
}
