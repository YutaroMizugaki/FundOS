// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {FundConstitution} from "./FundConstitution.sol";

/// @title TreasuryVault
/// @notice Holds JPYC and maintains separated accounting for protected principal and grant budget.
contract TreasuryVault is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error GrantControllerAlreadySet();
    error OnlyGrantController();
    error InsufficientAllowance();
    error InsufficientGrantBudget();
    error JPYCRescueForbidden();
    error OnlyInitializer();
    error InsufficientAccountingSurplus();
    error FundNotActive();
    error InvalidDissolutionRecipient();
    error InvalidLifecycle();

    FundConstitution public immutable constitution;
    IERC20 public immutable jpyc;
    address public immutable initializer;

    address public grantController;

    enum FundLifecycle {
        Active,
        DissolutionPending,
        Dissolved
    }

    FundLifecycle public lifecycle;

    uint256 private _protectedPrincipal;
    uint256 private _availableGrantBudget;

    event PrincipalDonated(address indexed donor, uint256 amount, bytes32 donorRef);
    event GrantBudgetFunded(address indexed funder, uint256 amount, bytes32 sourceRef);
    event GrantTransferExecuted(address indexed recipient, uint256 amount);
    event GrantControllerAuthorized(address indexed grantController);
    event FundPaused(address account);
    event FundUnpaused(address account);
    event YieldRecognized(uint256 amount, bytes32 indexed evidenceHash);
    event FundDissolved(address indexed recipient, uint256 amount);
    event DissolutionAccountingLocked();
    event DissolutionAccountingUnlocked();

    constructor(FundConstitution constitution_) {
        if (address(constitution_) == address(0)) revert ZeroAddress();
        constitution = constitution_;
        jpyc = constitution_.jpyc();
        initializer = msg.sender;
    }

    modifier onlyActive() {
        if (lifecycle != FundLifecycle.Active) revert FundNotActive();
        _;
    }

    /// @notice One-time wiring from GrantController deployment.
    function authorizeGrantController(address controller) external {
        if (msg.sender != initializer) revert OnlyInitializer();
        if (grantController != address(0)) revert GrantControllerAlreadySet();
        if (controller == address(0)) revert ZeroAddress();
        grantController = controller;
        emit GrantControllerAuthorized(controller);
    }

    function donatePrincipal(uint256 amount, bytes32 donorRef) external nonReentrant onlyActive {
        if (amount == 0) revert ZeroAmount();
        _transferIn(msg.sender, amount);
        _protectedPrincipal += amount;
        emit PrincipalDonated(msg.sender, amount, donorRef);
    }

    function fundGrantBudget(uint256 amount, bytes32 sourceRef) external nonReentrant onlyActive {
        if (amount == 0) revert ZeroAmount();
        _transferIn(msg.sender, amount);
        _availableGrantBudget += amount;
        emit GrantBudgetFunded(msg.sender, amount, sourceRef);
    }

    /// @notice Executes an approved grant transfer. Only callable by GrantController.
    function executeGrantTransfer(address recipient, uint256 amount) external nonReentrant whenNotPaused {
        if (msg.sender != grantController) revert OnlyGrantController();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > _availableGrantBudget) revert InsufficientGrantBudget();

        _availableGrantBudget -= amount;
        jpyc.safeTransfer(recipient, amount);
        emit GrantTransferExecuted(recipient, amount);
    }

    /// @notice Reclassifies verified realized yield already held by the treasury as grant budget.
    /// @dev No tokens move. The controller must complete its approval and timelock workflow first.
    function recognizeYield(uint256 amount, bytes32 evidenceHash) external nonReentrant whenNotPaused onlyActive {
        if (msg.sender != grantController) revert OnlyGrantController();
        if (amount == 0) revert ZeroAmount();
        if (amount > accountingSurplus()) revert InsufficientAccountingSurplus();

        _availableGrantBudget += amount;
        emit YieldRecognized(amount, evidenceHash);
    }

    function beginDissolution() external whenPaused onlyActive {
        if (msg.sender != grantController) revert OnlyGrantController();
        lifecycle = FundLifecycle.DissolutionPending;
        emit DissolutionAccountingLocked();
    }

    function cancelDissolution() external whenPaused {
        if (msg.sender != grantController) revert OnlyGrantController();
        if (lifecycle != FundLifecycle.DissolutionPending) revert InvalidLifecycle();
        lifecycle = FundLifecycle.Active;
        emit DissolutionAccountingUnlocked();
    }

    /// @notice Transfers all residual JPYC to the constitution's immutable recipient.
    /// @dev This is the only non-grant JPYC outflow and is permanently terminal.
    function executeDissolution(address recipient) external nonReentrant whenPaused {
        if (msg.sender != grantController) revert OnlyGrantController();
        if (lifecycle != FundLifecycle.DissolutionPending) revert InvalidLifecycle();
        if (recipient != constitution.dissolutionRecipient()) {
            revert InvalidDissolutionRecipient();
        }

        uint256 amount = jpyc.balanceOf(address(this));
        lifecycle = FundLifecycle.Dissolved;
        _protectedPrincipal = 0;
        _availableGrantBudget = 0;

        if (amount != 0) jpyc.safeTransfer(recipient, amount);
        emit FundDissolved(recipient, amount);
    }

    /// @notice Rescue mistakenly sent ERC-20 tokens. JPYC is never recoverable.
    function rescueToken(IERC20 token, address to, uint256 amount) external nonReentrant {
        if (msg.sender != grantController) revert OnlyGrantController();
        if (address(token) == address(jpyc)) revert JPYCRescueForbidden();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        token.safeTransfer(to, amount);
    }

    function pause() external {
        if (msg.sender != grantController) revert OnlyGrantController();
        _pause();
        emit FundPaused(msg.sender);
    }

    function unpause() external {
        if (msg.sender != grantController) revert OnlyGrantController();
        if (lifecycle != FundLifecycle.Active) revert FundNotActive();
        _unpause();
        emit FundUnpaused(msg.sender);
    }

    function protectedPrincipal() external view returns (uint256) {
        return _protectedPrincipal;
    }

    function availableGrantBudget() external view returns (uint256) {
        return _availableGrantBudget;
    }

    function totalTreasuryAssets() external view returns (uint256) {
        return jpyc.balanceOf(address(this));
    }

    function accountingSurplus() public view returns (uint256) {
        uint256 balance = jpyc.balanceOf(address(this));
        uint256 accounted = _protectedPrincipal + _availableGrantBudget;
        if (balance <= accounted) return 0;
        return balance - accounted;
    }

    function _transferIn(address from, uint256 amount) internal {
        uint256 allowance = jpyc.allowance(from, address(this));
        if (allowance < amount) revert InsufficientAllowance();
        jpyc.safeTransferFrom(from, address(this), amount);
    }
}
