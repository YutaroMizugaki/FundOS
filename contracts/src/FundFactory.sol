// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AutonomousFundVault} from "./AutonomousFundVault.sol";
import {PolicyEngine} from "./PolicyEngine.sol";
import {IPolicyEngine} from "./interfaces/IPolicyEngine.sol";

/// @title FundFactory
/// @notice Deploys a new policy-bounded autonomous fund (vault + policy engine pair).
contract FundFactory {
    event FundCreated(
        address indexed vault,
        address indexed policyEngine,
        address indexed baseAsset,
        address admin,
        address executor
    );

    struct FundConfig {
        IERC20 baseAsset;
        string vaultName;
        string vaultSymbol;
        address admin;
        address executor;
        IPolicyEngine.PolicyConfig policy;
        address[] initialAssets;
    }

    function createFund(FundConfig calldata config)
        external
        returns (AutonomousFundVault vault, PolicyEngine engine)
    {
        address[] memory assets = _mergeAssets(config.baseAsset, config.initialAssets);
        engine = new PolicyEngine(
            config.admin, config.executor, config.policy, assets, address(this)
        );

        vault = new AutonomousFundVault(
            config.baseAsset,
            config.vaultName,
            config.vaultSymbol,
            IPolicyEngine(address(engine)),
            config.admin
        );

        engine.registerVault(address(vault));

        emit FundCreated(
            address(vault), address(engine), address(config.baseAsset), config.admin, config.executor
        );
    }

    function _mergeAssets(IERC20 baseAsset, address[] calldata extra)
        private
        pure
        returns (address[] memory)
    {
        address[] memory assets = new address[](extra.length + 1);
        assets[0] = address(baseAsset);
        for (uint256 i = 0; i < extra.length; i++) {
            assets[i + 1] = extra[i];
        }
        return assets;
    }
}
