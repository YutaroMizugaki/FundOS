// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFundManager
/// @notice External interface exposed by FundManager to the vault and governance
interface IFundManager {
    struct StrategyInfo {
        address strategy;
        uint16 targetBps;      // target allocation in basis points (10000 = 100%)
        uint256 deployedAssets;
        bool active;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────────

    event StrategyAdded(address indexed strategy, uint16 targetBps);
    event StrategyRemoved(address indexed strategy);
    event AllocationUpdated(address indexed strategy, uint16 newTargetBps);
    event Rebalanced(uint256 totalAssets);
    event Harvested(uint256 totalProfit);

    // ──────────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────────

    function totalAssets() external view returns (uint256);
    function idleAssets() external view returns (uint256);
    function strategyCount() external view returns (uint256);
    function getStrategy(uint256 index) external view returns (StrategyInfo memory);
    function getStrategyByAddress(address strategy) external view returns (StrategyInfo memory);

    // ──────────────────────────────────────────────────────────────────────────
    // Strategy management (governance-controlled)
    // ──────────────────────────────────────────────────────────────────────────

    function addStrategy(address strategy, uint16 targetBps) external;
    function removeStrategy(address strategy) external;
    function updateAllocation(address strategy, uint16 newTargetBps) external;

    // ──────────────────────────────────────────────────────────────────────────
    // Autonomous operations (keeper / anyone)
    // ──────────────────────────────────────────────────────────────────────────

    function rebalance() external;
    function harvestAll() external returns (uint256 totalProfit);

    // ──────────────────────────────────────────────────────────────────────────
    // Capital flow (vault-only)
    // ──────────────────────────────────────────────────────────────────────────

    function deployCapital(uint256 amount) external;
    function withdrawCapital(uint256 amount) external;
}
