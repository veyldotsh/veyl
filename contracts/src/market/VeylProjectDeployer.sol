// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentToken, AgentTreasury} from "../AgentKit.sol";
import {RevenueRouter} from "../Funding.sol";
import {QuoteRevenueRouter} from "../QuoteRevenueRouter.sol";
import {VeylMarketTypes as T} from "./VeylMarketTypes.sol";

/// @dev Immutable factory-only module keeps the market factory below EVM code-size limits.
contract VeylProjectDeployer {
    address public immutable factory;
    address public immutable protocol;
    address public immutable poolManager;
    address public immutable quoteAsset;
    address public immutable conversionSwapRouter;
    error NotFactory();

    constructor(
        address factory_,
        address protocol_,
        address poolManager_,
        address quoteAsset_,
        address conversionSwapRouter_
    ) {
        factory = factory_;
        protocol = protocol_;
        poolManager = poolManager_;
        quoteAsset = quoteAsset_;
        conversionSwapRouter = conversionSwapRouter_;
    }

    function deploy(bytes32 id, address creator, T.LaunchConfig calldata config)
        external
        returns (address token, address treasury, address revenueRouter)
    {
        if (msg.sender != factory) revert NotFactory();
        token = address(
            new AgentToken{salt: id}(config.name, config.symbol, factory, config.launchProtection, poolManager)
        );
        treasury = address(new AgentTreasury{salt: id}(config.treasuryOwner, config.operator, config.dailyLimit));
        revenueRouter = quoteAsset == address(0)
            ? address(new RevenueRouter{salt: id}(treasury, creator, protocol))
            : address(
                new QuoteRevenueRouter{salt: id}(
                    quoteAsset, AgentTreasury(payable(treasury)), creator, protocol, conversionSwapRouter
                )
            );
    }

    function predict(bytes32 id, address creator, T.LaunchConfig calldata config)
        external
        view
        returns (address token, address treasury, address revenueRouter)
    {
        bytes memory tokenCode = abi.encodePacked(
            type(AgentToken).creationCode,
            abi.encode(config.name, config.symbol, factory, config.launchProtection, poolManager)
        );
        token = _predict(id, keccak256(tokenCode));
        treasury = _predict(
            id,
            keccak256(
                abi.encodePacked(
                    type(AgentTreasury).creationCode,
                    abi.encode(config.treasuryOwner, config.operator, config.dailyLimit)
                )
            )
        );
        bytes memory revenueCode = quoteAsset == address(0)
            ? abi.encodePacked(type(RevenueRouter).creationCode, abi.encode(treasury, creator, protocol))
            : abi.encodePacked(
                type(QuoteRevenueRouter).creationCode,
                abi.encode(quoteAsset, treasury, creator, protocol, conversionSwapRouter)
            );
        revenueRouter = _predict(id, keccak256(revenueCode));
    }

    function _predict(bytes32 salt, bytes32 hash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, hash)))));
    }
}
