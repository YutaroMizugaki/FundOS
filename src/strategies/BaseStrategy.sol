// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IStrategy.sol";

/// @title BaseStrategy
/// @notice Abstract base for all FundOS strategies.
///         Sub-contracts implement `_deposit`, `_withdraw`, `_harvest`, and
///         `_totalAssets` to plug into the FundManager lifecycle.
abstract contract BaseStrategy is IStrategy, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────────

    IERC20 public immutable override asset;
    address public manager;
    string public override name;

    bool public emergencyExited;

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────────

    constructor(address _asset, address _manager, string memory _name) Ownable(msg.sender) {
        require(_asset != address(0), "Strategy: zero asset");
        require(_manager != address(0), "Strategy: zero manager");
        asset = IERC20(_asset);
        manager = _manager;
        name = _name;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────────────────

    modifier onlyManager() {
        require(msg.sender == manager, "Strategy: caller is not manager");
        _;
    }

    modifier notEmergencyExited() {
        require(!emergencyExited, "Strategy: emergency exited");
        _;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // IStrategy – public entrypoints (delegate to internal hooks)
    // ──────────────────────────────────────────────────────────────────────────

    function deposit(uint256 amount)
        external
        override
        onlyManager
        nonReentrant
        notEmergencyExited
    {
        require(amount > 0, "Strategy: zero deposit");
        asset.safeTransferFrom(manager, address(this), amount);
        _deposit(amount);
        emit Deposited(amount);
    }

    function withdraw(uint256 amount)
        external
        override
        onlyManager
        nonReentrant
    {
        require(amount > 0, "Strategy: zero withdraw");
        _withdraw(amount);
        asset.safeTransfer(manager, asset.balanceOf(address(this)));
        emit Withdrawn(amount);
    }

    function harvest()
        external
        override
        onlyManager
        nonReentrant
        notEmergencyExited
        returns (uint256 profit)
    {
        profit = _harvest();
        if (profit > 0) {
            asset.safeTransfer(manager, profit);
            emit Harvested(profit);
        }
    }

    function totalAssets() external view override returns (uint256) {
        return _totalAssets();
    }

    function emergencyExit() external override onlyManager nonReentrant {
        emergencyExited = true;
        _emergencyExit();
        uint256 balance = asset.balanceOf(address(this));
        if (balance > 0) {
            asset.safeTransfer(manager, balance);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal hooks – override in sub-contracts
    // ──────────────────────────────────────────────────────────────────────────

    function _deposit(uint256 amount) internal virtual;
    function _withdraw(uint256 amount) internal virtual;
    function _harvest() internal virtual returns (uint256 profit);
    function _totalAssets() internal view virtual returns (uint256);
    function _emergencyExit() internal virtual {}

    // ──────────────────────────────────────────────────────────────────────────
    // Owner helpers
    // ──────────────────────────────────────────────────────────────────────────

    function setManager(address _manager) external onlyOwner {
        require(_manager != address(0), "Strategy: zero manager");
        manager = _manager;
    }
}
