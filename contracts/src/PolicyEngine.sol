// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPolicyEngine} from "./interfaces/IPolicyEngine.sol";

/// @title PolicyEngine
/// @notice Enforces hard-coded spending and asset rules for autonomous fund execution.
contract PolicyEngine is IPolicyEngine, AccessControl {
    bytes32 public constant POLICY_ADMIN_ROLE = keccak256("POLICY_ADMIN_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    PolicyConfig private _policy;
    address private _executor;
    address private immutable _bootstrapper;
    bool private _vaultRegistered;

    mapping(address => bool) private _allowedAssets;
    mapping(uint256 => uint256) private _dailySpend; // day index => cumulative spend

    constructor(
        address admin,
        address executor_,
        PolicyConfig memory initialPolicy,
        address[] memory initialAssets,
        address bootstrapper
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(POLICY_ADMIN_ROLE, admin);
        _executor = executor_;
        _bootstrapper = bootstrapper;
        _policy = initialPolicy;
        for (uint256 i = 0; i < initialAssets.length; i++) {
            _allowedAssets[initialAssets[i]] = true;
            emit AssetWhitelisted(initialAssets[i], true);
        }
        emit ExecutorUpdated(executor_);
        emit PolicyUpdated(initialPolicy);
    }

    function policy() external view returns (PolicyConfig memory) {
        return _policy;
    }

    function executor() external view returns (address) {
        return _executor;
    }

    function isAssetAllowed(address asset) public view returns (bool) {
        return _allowedAssets[asset];
    }

    function dailySpendToday() public view returns (uint256) {
        return _dailySpend[_dayIndex(block.timestamp)];
    }

    function validateTransfer(
        address asset,
        uint256 amount,
        uint256 totalAssets,
        uint256 cashBalance
    ) external view returns (bool) {
        if (!_policy.autonomousMode) return false;
        if (!_allowedAssets[asset]) return false;
        if (amount == 0) return false;
        if (totalAssets == 0) return false;

        uint256 minReserve = (totalAssets * _policy.minCashReserveBps) / 10_000;
        if (cashBalance < amount || cashBalance - amount < minReserve) return false;

        uint256 maxTransfer = (totalAssets * _policy.maxTransferBps) / 10_000;
        if (amount > maxTransfer) return false;

        if (_dailySpend[_dayIndex(block.timestamp)] + amount > _policy.dailySpendCap) {
            return false;
        }

        return true;
    }

    function recordSpend(uint256 amount) external onlyRole(VAULT_ROLE) {
        uint256 day = _dayIndex(block.timestamp);
        _dailySpend[day] += amount;
        emit SpendRecorded(amount, _dailySpend[day]);
    }

    /// @notice One-time vault linkage during fund creation.
    function registerVault(address vault) external {
        require(msg.sender == _bootstrapper, "PolicyEngine: not bootstrapper");
        require(!_vaultRegistered, "PolicyEngine: vault already registered");
        _vaultRegistered = true;
        _grantRole(VAULT_ROLE, vault);
    }

    function setExecutor(address newExecutor) external onlyRole(POLICY_ADMIN_ROLE) {
        _executor = newExecutor;
        emit ExecutorUpdated(newExecutor);
    }

    function setAutonomousMode(bool enabled) external onlyRole(POLICY_ADMIN_ROLE) {
        _policy.autonomousMode = enabled;
        emit PolicyUpdated(_policy);
    }

    function setAssetAllowed(address asset, bool allowed) external onlyRole(POLICY_ADMIN_ROLE) {
        _allowedAssets[asset] = allowed;
        emit AssetWhitelisted(asset, allowed);
    }

    function updatePolicy(PolicyConfig calldata config) external onlyRole(POLICY_ADMIN_ROLE) {
        _policy = config;
        emit PolicyUpdated(config);
    }

    function _dayIndex(uint256 timestamp) private pure returns (uint256) {
        return timestamp / 1 days;
    }
}
