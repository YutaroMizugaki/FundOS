// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPolicyEngine
/// @notice On-chain guardrails for autonomous fund operations (policy-bounded autonomy).
interface IPolicyEngine {
    struct PolicyConfig {
        /// @dev Minimum cash reserve as basis points of total assets (e.g. 1000 = 10%).
        uint16 minCashReserveBps;
        /// @dev Maximum single transfer as basis points of total assets.
        uint16 maxTransferBps;
        /// @dev Maximum cumulative outbound transfers per UTC day.
        uint256 dailySpendCap;
        /// @dev Whether the agent may execute without human approval when policy passes.
        bool autonomousMode;
    }

    event PolicyUpdated(PolicyConfig config);
    event AssetWhitelisted(address indexed asset, bool allowed);
    event ExecutorUpdated(address indexed executor);
    event SpendRecorded(uint256 amount, uint256 daySpend);

    function policy() external view returns (PolicyConfig memory);

    function isAssetAllowed(address asset) external view returns (bool);

    function executor() external view returns (address);

    /// @notice Validates a proposed outbound transfer against current policy.
    function validateTransfer(
        address asset,
        uint256 amount,
        uint256 totalAssets,
        uint256 cashBalance
    ) external view returns (bool);

    /// @notice Records spend against the daily cap. Callable only by the linked vault.
    function recordSpend(uint256 amount) external;

    function setExecutor(address newExecutor) external;

    function setAutonomousMode(bool enabled) external;

    function setAssetAllowed(address asset, bool allowed) external;

    function updatePolicy(PolicyConfig calldata config) external;
}
