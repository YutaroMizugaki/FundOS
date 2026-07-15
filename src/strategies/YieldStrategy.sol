// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./BaseStrategy.sol";

/// @title YieldStrategy
/// @notice A self-contained yield strategy that simulates interest accrual.
///         In production this would integrate with an external yield source
///         (e.g. Aave, Compound, Yearn, RWA protocols).
///
///         Yield accrues continuously at `annualYieldBps` (basis points per year).
///         `harvest()` crystallises the accrued yield as profit, resets the
///         accrual clock, and returns the profit to FundManager.
contract YieldStrategy is BaseStrategy {
    // ──────────────────────────────────────────────────────────────────────────
    // Constants & state
    // ──────────────────────────────────────────────────────────────────────────

    uint256 public constant BPS = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    uint256 public annualYieldBps;   // e.g. 500 = 5% APY
    uint256 public principal;        // assets currently deployed
    uint256 public lastHarvestTime;  // timestamp of last harvest

    // ──────────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────────

    event YieldRateUpdated(uint256 newAnnualYieldBps);

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────────

    constructor(
        address _asset,
        address _manager,
        uint256 _annualYieldBps
    ) BaseStrategy(_asset, _manager, "YieldStrategy") {
        require(_annualYieldBps <= 5000, "YieldStrategy: yield too high"); // max 50% APY
        annualYieldBps = _annualYieldBps;
        lastHarvestTime = block.timestamp;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // BaseStrategy hooks
    // ──────────────────────────────────────────────────────────────────────────

    function _deposit(uint256 amount) internal override {
        principal += amount;
    }

    function _withdraw(uint256 amount) internal override {
        if (amount > principal) amount = principal;
        principal -= amount;
        // In a real strategy this would redeem from an external protocol.
        // Here the asset balance already holds the funds.
    }

    /// @dev Computes time-weighted yield on the principal and transfers it out.
    function _harvest() internal override returns (uint256 profit) {
        profit = _pendingYield();
        // Reset accrual window regardless of profit amount
        lastHarvestTime = block.timestamp;

        if (profit > 0) {
            // In production: collect yield tokens from an external protocol here.
            // For simulation we mint by transferring from the contract's own balance,
            // which the test harness pre-funds.
            uint256 available = asset.balanceOf(address(this)) > principal
                ? asset.balanceOf(address(this)) - principal
                : 0;
            if (profit > available) profit = available;
        }
    }

    function _totalAssets() internal view override returns (uint256) {
        return principal;
    }

    /// @dev On emergency exit liquidate all tracked principal immediately.
    function _emergencyExit() internal override {
        principal = 0;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Yield accrued since the last harvest, not yet collected.
    function pendingYield() external view returns (uint256) {
        return _pendingYield();
    }

    function _pendingYield() internal view returns (uint256) {
        if (principal == 0 || annualYieldBps == 0) return 0;
        uint256 elapsed = block.timestamp - lastHarvestTime;
        return (principal * annualYieldBps * elapsed) / (BPS * SECONDS_PER_YEAR);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Owner
    // ──────────────────────────────────────────────────────────────────────────

    function setYieldRate(uint256 _annualYieldBps) external onlyOwner {
        require(_annualYieldBps <= 5000, "YieldStrategy: yield too high");
        annualYieldBps = _annualYieldBps;
        emit YieldRateUpdated(_annualYieldBps);
    }
}
