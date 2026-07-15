// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IPolicyEngine} from "./interfaces/IPolicyEngine.sol";

/// @title AutonomousFundVault
/// @notice ERC-4626 vault holding programmable money with policy-bounded autonomous execution.
contract AutonomousFundVault is ERC4626, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IPolicyEngine public immutable policyEngine;

    event ManagedTransfer(
        address indexed executor,
        address indexed asset,
        address indexed to,
        uint256 amount,
        bytes32 reasonHash
    );

    constructor(
        IERC20 asset,
        string memory name,
        string memory symbol,
        IPolicyEngine policyEngine_,
        address admin
    ) ERC20(name, symbol) ERC4626(asset) {
        policyEngine = policyEngine_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice Agent-driven outbound transfer within policy guardrails.
  /// @param reasonHash Hash of off-chain context (strategy snapshot, market state) for audit trail.
    function executeManagedTransfer(
        address token,
        address to,
        uint256 amount,
        bytes32 reasonHash
    ) external whenNotPaused {
        require(msg.sender == policyEngine.executor(), "FundVault: not executor");

        uint256 total = totalAssets();
        uint256 cash = IERC20(asset()).balanceOf(address(this));

        require(
            policyEngine.validateTransfer(token, amount, total, cash),
            "FundVault: policy rejected"
        );

        policyEngine.recordSpend(amount);
        IERC20(token).safeTransfer(to, amount);

        emit ManagedTransfer(msg.sender, token, to, amount, reasonHash);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override whenNotPaused returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner);
    }

    /// @dev Total assets = base asset balance. Extend with oracle-priced positions in production.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }
}
