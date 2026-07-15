// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Pluggable rule-set that a FundVault executes autonomously.
/// Implementations decide *how* idle programmable-money assets held by the
/// vault should be deployed each time `autoExecute` is triggered, without
/// requiring any human approval for each individual action.
interface IFundStrategy {
    /// @return True if the strategy currently has an action to perform.
    /// @param idleAssets Amount of the vault's asset available to act on.
    /// @param lastExecutedAt Unix timestamp the strategy last ran at (0 if never).
    function shouldExecute(uint256 idleAssets, uint256 lastExecutedAt) external view returns (bool);

    /// @notice Called by the vault with a pre-approved allowance of `asset`
    /// worth up to `idleAssets`. The strategy pulls whatever it needs via
    /// `transferFrom(vault, ..., amount)` and returns the amount actually consumed.
    /// @dev `msg.sender` is the calling FundVault.
    function execute(IERC20 asset, uint256 idleAssets) external returns (uint256 assetsConsumed);

    /// @return Minimum number of seconds that must elapse between executions.
    function minInterval() external view returns (uint256);
}
