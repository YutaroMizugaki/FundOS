// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IStrategy
/// @notice Interface for pluggable investment strategies within FundOS
interface IStrategy {
    // ──────────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────────

    event Deposited(uint256 amount);
    event Withdrawn(uint256 amount);
    event Harvested(uint256 profit);

    // ──────────────────────────────────────────────────────────────────────────
    // Getters
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Address of the underlying asset this strategy works with
    function asset() external view returns (IERC20);

    /// @notice Total assets (principal + unrealised profit) managed by this strategy
    function totalAssets() external view returns (uint256);

    /// @notice Human-readable name for the strategy
    function name() external view returns (string memory);

    // ──────────────────────────────────────────────────────────────────────────
    // Capital flow
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Deploy `amount` of the underlying asset into the strategy.
    ///         Caller must have approved this contract to spend the asset.
    /// @param amount Amount of asset to deposit
    function deposit(uint256 amount) external;

    /// @notice Withdraw `amount` of the underlying asset back to the caller (FundManager).
    /// @param amount Amount of asset to withdraw
    function withdraw(uint256 amount) external;

    /// @notice Collect accrued yield and send it to the FundManager.
    ///         Returns the amount of profit harvested.
    function harvest() external returns (uint256 profit);

    // ──────────────────────────────────────────────────────────────────────────
    // Emergency
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Immediately liquidate all positions and return assets to FundManager.
    function emergencyExit() external;
}
