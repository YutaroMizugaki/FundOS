// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFundStrategy} from "./IFundStrategy.sol";

/// @title FundVault
/// @notice An autonomous, self-operating fund built on top of programmable
/// money (any ERC20, e.g. a stablecoin). Depositors receive ERC4626 shares
/// representing a claim on the pooled assets. A pluggable, governance-set
/// `IFundStrategy` decides how the fund's idle assets are deployed, and that
/// logic is triggered *permissionlessly* via `autoExecute` — by a bot, a
/// Chainlink Automation-style keeper, a cron job, or any other caller — so the
/// fund keeps running without requiring a human to sign off on every action.
///
/// Safety valves:
///  - `reserveRatioBps` always keeps a slice of assets back so depositors can
///    still redeem their shares even while the strategy is actively deploying
///    capital.
///  - Governance actions (changing the strategy, reserve ratio, pausing) are
///    gated by `onlyOwner`; deploying the owner as a `TimelockController`
///    (see scripts/deploy.ts) adds a mandatory delay + transparency window
///    before any such change takes effect.
contract FundVault is ERC4626, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;

    IFundStrategy public strategy;
    uint256 public lastExecutedAt;
    uint16 public reserveRatioBps = 2_000; // 20% held back for pending redemptions by default

    event StrategyUpdated(address indexed oldStrategy, address indexed newStrategy);
    event ReserveRatioUpdated(uint16 oldRatioBps, uint16 newRatioBps);
    event AutoExecuted(address indexed keeper, uint256 idleAssetsOffered, uint256 assetsConsumed, uint256 timestamp);

    error StrategyNotDue();
    error NoStrategySet();
    error InvalidRatio();

    constructor(IERC20 asset_, string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(owner_)
    {}

    /// @notice Swap out the autonomous strategy. Intended to be called by a
    /// timelocked governance contract, not a single hot-wallet key.
    function setStrategy(IFundStrategy newStrategy) external onlyOwner {
        address old = address(strategy);
        strategy = newStrategy;
        emit StrategyUpdated(old, address(newStrategy));
    }

    /// @notice Update the percentage of assets kept back for redemptions.
    function setReserveRatioBps(uint16 newRatioBps) external onlyOwner {
        if (newRatioBps > BPS_DENOMINATOR) revert InvalidRatio();
        emit ReserveRatioUpdated(reserveRatioBps, newRatioBps);
        reserveRatioBps = newRatioBps;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Idle, distributable assets currently sitting in the vault,
    /// after holding back `reserveRatioBps` for pending redemptions.
    function idleAssets() public view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 reserve = (balance * reserveRatioBps) / BPS_DENOMINATOR;
        return balance > reserve ? balance - reserve : 0;
    }

    /// @notice Permissionlessly triggers the fund's autonomous strategy. The
    /// strategy itself decides (via `shouldExecute`) whether there is
    /// anything to do; this function simply offers it access to the vault's
    /// idle assets and records when it last ran.
    function autoExecute() external nonReentrant whenNotPaused returns (uint256 assetsConsumed) {
        IFundStrategy currentStrategy = strategy;
        if (address(currentStrategy) == address(0)) revert NoStrategySet();

        uint256 available = idleAssets();
        if (!currentStrategy.shouldExecute(available, lastExecutedAt)) revert StrategyNotDue();

        IERC20 token = IERC20(asset());
        token.forceApprove(address(currentStrategy), available);
        assetsConsumed = currentStrategy.execute(token, available);
        token.forceApprove(address(currentStrategy), 0);

        lastExecutedAt = block.timestamp;
        emit AutoExecuted(msg.sender, available, assetsConsumed, block.timestamp);
    }
}
