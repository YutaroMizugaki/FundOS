// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IFundManager.sol";

/// @title FundManager
/// @notice Autonomous capital allocator.  Holds the fund's idle liquidity and
///         orchestrates deposits into / withdrawals from registered strategies.
///
///         Rebalancing logic
///         ─────────────────
///         Each strategy has a `targetBps` (basis points, sum ≤ 10 000).
///         Any remainder implicitly stays idle in this contract.
///         `rebalance()` computes the delta for each strategy and issues
///         deposit / withdraw calls to close the gap.
///
///         Autonomy
///         ────────
///         `rebalance()` and `harvestAll()` are permissionless – anyone
///         (including Chainlink Automation / Gelato keepers) can call them,
///         incentivising regular execution without governance overhead.
contract FundManager is IFundManager, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────────────────

    uint256 public constant MAX_STRATEGIES = 20;
    uint256 public constant BPS = 10_000;
    /// Minimum deviation (in BPS) before rebalancing a strategy position.
    uint256 public constant REBALANCE_THRESHOLD_BPS = 100; // 1%

    // ──────────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────────

    IERC20 public immutable asset;
    address public vault;

    StrategyInfo[] private _strategies;
    mapping(address => uint256) private _strategyIndex; // strategy → index+1 (0 = not found)

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────────

    constructor(address _asset, address _vault) Ownable(msg.sender) {
        require(_asset != address(0), "FundManager: zero asset");
        require(_vault != address(0), "FundManager: zero vault");
        asset = IERC20(_asset);
        vault = _vault;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────────────────

    modifier onlyVault() {
        require(msg.sender == vault, "FundManager: caller is not vault");
        _;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // IFundManager – views
    // ──────────────────────────────────────────────────────────────────────────

    function totalAssets() public view override returns (uint256) {
        uint256 total = asset.balanceOf(address(this));
        uint256 len = _strategies.length;
        for (uint256 i = 0; i < len; ++i) {
            if (_strategies[i].active) {
                total += IStrategy(_strategies[i].strategy).totalAssets();
            }
        }
        return total;
    }

    function idleAssets() external view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function strategyCount() external view override returns (uint256) {
        return _strategies.length;
    }

    function getStrategy(uint256 index) external view override returns (StrategyInfo memory) {
        require(index < _strategies.length, "FundManager: index out of range");
        return _strategies[index];
    }

    function getStrategyByAddress(address strategy) external view override returns (StrategyInfo memory) {
        uint256 idx = _strategyIndex[strategy];
        require(idx > 0, "FundManager: strategy not found");
        return _strategies[idx - 1];
    }

    // ──────────────────────────────────────────────────────────────────────────
    // IFundManager – strategy management (owner / governance)
    // ──────────────────────────────────────────────────────────────────────────

    function addStrategy(address strategy, uint16 targetBps) external override onlyOwner {
        require(strategy != address(0), "FundManager: zero strategy");
        require(_strategyIndex[strategy] == 0, "FundManager: already added");
        require(_strategies.length < MAX_STRATEGIES, "FundManager: max strategies");
        require(address(IStrategy(strategy).asset()) == address(asset), "FundManager: asset mismatch");

        uint256 totalBps = uint256(targetBps);
        for (uint256 i = 0; i < _strategies.length; ++i) {
            if (_strategies[i].active) totalBps += _strategies[i].targetBps;
        }
        require(totalBps <= BPS, "FundManager: allocation exceeds 100%");

        _strategies.push(StrategyInfo({
            strategy: strategy,
            targetBps: targetBps,
            deployedAssets: 0,
            active: true
        }));
        _strategyIndex[strategy] = _strategies.length; // 1-based
        emit StrategyAdded(strategy, targetBps);
    }

    function removeStrategy(address strategy) external override onlyOwner {
        uint256 idx = _strategyIndex[strategy];
        require(idx > 0, "FundManager: strategy not found");

        StrategyInfo storage info = _strategies[idx - 1];
        // Liquidate all positions before removal
        if (info.deployedAssets > 0) {
            IStrategy(strategy).withdraw(info.deployedAssets);
            info.deployedAssets = 0;
        }
        info.active = false;
        info.targetBps = 0;
        delete _strategyIndex[strategy];
        emit StrategyRemoved(strategy);
    }

    function updateAllocation(address strategy, uint16 newTargetBps) external override onlyOwner {
        uint256 idx = _strategyIndex[strategy];
        require(idx > 0, "FundManager: strategy not found");
        require(_strategies[idx - 1].active, "FundManager: strategy not active");

        uint256 totalBps = uint256(newTargetBps);
        for (uint256 i = 0; i < _strategies.length; ++i) {
            if (_strategies[i].active && _strategies[i].strategy != strategy) {
                totalBps += _strategies[i].targetBps;
            }
        }
        require(totalBps <= BPS, "FundManager: allocation exceeds 100%");

        _strategies[idx - 1].targetBps = newTargetBps;
        emit AllocationUpdated(strategy, newTargetBps);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // IFundManager – autonomous operations (permissionless)
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Rebalances strategy allocations toward their target weights.
    ///         Only adjusts positions where deviation exceeds REBALANCE_THRESHOLD_BPS.
    function rebalance() external override nonReentrant whenNotPaused {
        uint256 total = totalAssets();
        if (total == 0) return;

        uint256 len = _strategies.length;

        // First pass: withdraw from over-allocated strategies
        for (uint256 i = 0; i < len; ++i) {
            StrategyInfo storage info = _strategies[i];
            if (!info.active) continue;

            uint256 target = (total * info.targetBps) / BPS;
            uint256 current = IStrategy(info.strategy).totalAssets();

            if (current > target) {
                uint256 excess = current - target;
                // Only rebalance if deviation exceeds threshold
                if ((excess * BPS) / total >= REBALANCE_THRESHOLD_BPS) {
                    IStrategy(info.strategy).withdraw(excess);
                    info.deployedAssets = IStrategy(info.strategy).totalAssets();
                }
            }
        }

        // Refresh idle after withdrawals
        uint256 idle = asset.balanceOf(address(this));

        // Second pass: deposit into under-allocated strategies
        for (uint256 i = 0; i < len; ++i) {
            StrategyInfo storage info = _strategies[i];
            if (!info.active || idle == 0) continue;

            uint256 target = (total * info.targetBps) / BPS;
            uint256 current = IStrategy(info.strategy).totalAssets();

            if (target > current) {
                uint256 deficit = target - current;
                if ((deficit * BPS) / total >= REBALANCE_THRESHOLD_BPS) {
                    uint256 toDeposit = deficit > idle ? idle : deficit;
                    asset.forceApprove(info.strategy, toDeposit);
                    IStrategy(info.strategy).deposit(toDeposit);
                    info.deployedAssets = IStrategy(info.strategy).totalAssets();
                    idle -= toDeposit;
                }
            }
        }

        emit Rebalanced(total);
    }

    /// @notice Harvests yield from all strategies and returns total profit.
    function harvestAll() external override nonReentrant whenNotPaused returns (uint256 totalProfit) {
        uint256 len = _strategies.length;
        for (uint256 i = 0; i < len; ++i) {
            if (!_strategies[i].active) continue;
            uint256 profit = IStrategy(_strategies[i].strategy).harvest();
            totalProfit += profit;
            _strategies[i].deployedAssets = IStrategy(_strategies[i].strategy).totalAssets();
        }
        emit Harvested(totalProfit);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // IFundManager – capital flow (vault-only)
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Accepts newly deposited assets from the vault and deploys them
    ///         proportionally into strategies.
    function deployCapital(uint256 amount) external override onlyVault nonReentrant whenNotPaused {
        // assets have already been transferred to this contract by the vault
        uint256 len = _strategies.length;
        uint256 remaining = amount;

        for (uint256 i = 0; i < len && remaining > 0; ++i) {
            StrategyInfo storage info = _strategies[i];
            if (!info.active || info.targetBps == 0) continue;

            uint256 toDeposit = (amount * info.targetBps) / BPS;
            if (toDeposit > remaining) toDeposit = remaining;
            if (toDeposit == 0) continue;

            asset.forceApprove(info.strategy, toDeposit);
            IStrategy(info.strategy).deposit(toDeposit);
            info.deployedAssets += toDeposit;
            remaining -= toDeposit;
        }
        // Any remainder stays idle in this contract
    }

    /// @notice Liquidates strategy positions to return `amount` to the vault.
    function withdrawCapital(uint256 amount) external override onlyVault nonReentrant {
        uint256 idle = asset.balanceOf(address(this));
        if (idle >= amount) {
            asset.safeTransfer(vault, amount);
            return;
        }

        uint256 needed = amount - idle;
        uint256 len = _strategies.length;

        // Withdraw proportionally from active strategies
        uint256 totalDeployed;
        for (uint256 i = 0; i < len; ++i) {
            if (_strategies[i].active) totalDeployed += _strategies[i].deployedAssets;
        }

        for (uint256 i = 0; i < len && needed > 0; ++i) {
            StrategyInfo storage info = _strategies[i];
            if (!info.active || info.deployedAssets == 0) continue;

            uint256 share = totalDeployed > 0
                ? (needed * info.deployedAssets) / totalDeployed
                : needed;
            if (share > info.deployedAssets) share = info.deployedAssets;
            if (share == 0) continue;

            IStrategy(info.strategy).withdraw(share);
            info.deployedAssets = IStrategy(info.strategy).totalAssets();
            uint256 now_ = asset.balanceOf(address(this));
            uint256 received = now_ - idle;
            idle = now_;
            needed = needed > received ? needed - received : 0;
        }

        asset.safeTransfer(vault, amount > idle ? idle : amount);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Owner helpers
    // ──────────────────────────────────────────────────────────────────────────

    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "FundManager: zero vault");
        vault = _vault;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Rescue tokens accidentally sent to this contract (not the fund asset).
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(asset), "FundManager: cannot rescue fund asset");
        IERC20(token).safeTransfer(to, amount);
    }
}
