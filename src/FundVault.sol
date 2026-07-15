// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IFundManager.sol";

/// @title FundVault
/// @notice ERC-4626 tokenised vault.  Depositors receive fungible "FUND" share
///         tokens.  All deposited assets are forwarded to FundManager which
///         allocates them across programmed strategies.
///
///         Share price = totalAssets() / totalSupply()
///
///         Key design decisions
///         ─────────────────────
///         • totalAssets() is sourced from FundManager so share price
///           continuously reflects strategy P&L.
///         • A performance-fee mechanism mints new shares to the treasury on
///           each harvest, diluting existing holders by the fee %.
///         • Emergency pause blocks deposits/withdrawals (not mandatory exits).
contract FundVault is ERC4626, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────────────────

    uint256 public constant MAX_MANAGEMENT_FEE_BPS = 200;  // 2%
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 2000; // 20%
    uint256 public constant BPS = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ──────────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────────

    IFundManager public fundManager;
    address public treasury;

    uint256 public managementFeeBps;
    uint256 public performanceFeeBps;

    uint256 public highWaterMark;        // highest recorded totalAssets value (for perf fee)
    uint256 public lastFeeTimestamp;     // last time management fee was collected

    uint256 public depositCap;           // 0 = unlimited

    // ──────────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────────

    event FundManagerSet(address indexed oldManager, address indexed newManager);
    event TreasurySet(address indexed oldTreasury, address indexed newTreasury);
    event ManagementFeeCollected(uint256 sharesMinted, uint256 assetsRepresented);
    event PerformanceFeeCollected(uint256 sharesMinted, uint256 profit);
    event DepositCapUpdated(uint256 newCap);
    event FeesUpdated(uint256 managementFeeBps, uint256 performanceFeeBps);

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────────

    constructor(
        IERC20 _asset,
        string memory _name,
        string memory _symbol,
        address _treasury,
        uint256 _managementFeeBps,
        uint256 _performanceFeeBps
    ) ERC4626(_asset) ERC20(_name, _symbol) Ownable(msg.sender) {
        require(_treasury != address(0), "FundVault: zero treasury");
        require(_managementFeeBps <= MAX_MANAGEMENT_FEE_BPS, "FundVault: mgmt fee too high");
        require(_performanceFeeBps <= MAX_PERFORMANCE_FEE_BPS, "FundVault: perf fee too high");

        treasury = _treasury;
        managementFeeBps = _managementFeeBps;
        performanceFeeBps = _performanceFeeBps;
        lastFeeTimestamp = block.timestamp;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ERC-4626 overrides
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Reports total assets under management.
    ///         Includes vault-held idle liquidity (e.g. during in-flight withdrawals)
    ///         plus everything deployed through FundManager.
    function totalAssets() public view override returns (uint256) {
        uint256 vaultIdle = IERC20(asset()).balanceOf(address(this));
        if (address(fundManager) == address(0)) {
            return vaultIdle;
        }
        return vaultIdle + fundManager.totalAssets();
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        require(assets > 0, "FundVault: zero deposit");
        if (depositCap > 0) {
            require(totalAssets() + assets <= depositCap, "FundVault: cap exceeded");
        }
        _collectManagementFee();
        uint256 shares = super.deposit(assets, receiver);
        _forwardToManager(assets);
        return shares;
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        require(shares > 0, "FundVault: zero mint");
        _collectManagementFee();
        uint256 assets = super.mint(shares, receiver);
        _forwardToManager(assets);
        return assets;
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        require(assets > 0, "FundVault: zero withdraw");
        _collectManagementFee();
        _pullFromManager(assets);
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        require(shares > 0, "FundVault: zero redeem");
        _collectManagementFee();
        uint256 assets = previewRedeem(shares);
        _pullFromManager(assets);
        return super.redeem(shares, receiver, owner_);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Harvest  (callable by keeper or governance)
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Triggers strategy harvests, then charges performance fee on new profit.
    function harvest() external nonReentrant returns (uint256 totalProfit) {
        require(address(fundManager) != address(0), "FundVault: no manager");
        totalProfit = fundManager.harvestAll();
        uint256 afterHarvest = totalAssets();
        if (afterHarvest > highWaterMark) {
            uint256 profit = afterHarvest - highWaterMark;
            highWaterMark = afterHarvest;
            _collectPerformanceFee(profit);
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Owner / governance actions
    // ──────────────────────────────────────────────────────────────────────────

    function setFundManager(address _fundManager) external onlyOwner {
        address old = address(fundManager);
        fundManager = IFundManager(_fundManager);
        highWaterMark = totalAssets();
        emit FundManagerSet(old, _fundManager);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "FundVault: zero treasury");
        address old = treasury;
        treasury = _treasury;
        emit TreasurySet(old, _treasury);
    }

    function setFees(uint256 _managementFeeBps, uint256 _performanceFeeBps) external onlyOwner {
        require(_managementFeeBps <= MAX_MANAGEMENT_FEE_BPS, "FundVault: mgmt fee too high");
        require(_performanceFeeBps <= MAX_PERFORMANCE_FEE_BPS, "FundVault: perf fee too high");
        _collectManagementFee();
        managementFeeBps = _managementFeeBps;
        performanceFeeBps = _performanceFeeBps;
        emit FeesUpdated(_managementFeeBps, _performanceFeeBps);
    }

    function setDepositCap(uint256 _cap) external onlyOwner {
        depositCap = _cap;
        emit DepositCapUpdated(_cap);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev Push newly deposited assets into FundManager for deployment.
    function _forwardToManager(uint256 assets) internal {
        if (address(fundManager) == address(0)) return;
        IERC20(asset()).safeTransfer(address(fundManager), assets);
        fundManager.deployCapital(assets);
    }

    /// @dev Pull assets from FundManager to satisfy a withdrawal.
    function _pullFromManager(uint256 assets) internal {
        if (address(fundManager) == address(0)) return;
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle < assets) {
            fundManager.withdrawCapital(assets - idle);
        }
    }

    /// @dev Time-weighted management fee: mints shares to treasury.
    function _collectManagementFee() internal {
        if (managementFeeBps == 0 || treasury == address(0)) return;
        uint256 elapsed = block.timestamp - lastFeeTimestamp;
        if (elapsed == 0) return;
        lastFeeTimestamp = block.timestamp;

        uint256 supply = totalSupply();
        if (supply == 0) return;

        // fee = supply * feeBps/BPS * elapsed/SECONDS_PER_YEAR
        uint256 feeShares = (supply * managementFeeBps * elapsed) / (BPS * SECONDS_PER_YEAR);
        if (feeShares == 0) return;

        _mint(treasury, feeShares);
        emit ManagementFeeCollected(feeShares, convertToAssets(feeShares));
    }

    /// @dev Performance fee on new profit above high-water mark.
    function _collectPerformanceFee(uint256 profit) internal {
        if (performanceFeeBps == 0 || treasury == address(0) || profit == 0) return;

        // Convert the fee (expressed in assets) into shares at the current rate
        uint256 feeAssets = (profit * performanceFeeBps) / BPS;
        uint256 feeShares = convertToShares(feeAssets);
        if (feeShares == 0) return;

        _mint(treasury, feeShares);
        emit PerformanceFeeCollected(feeShares, profit);
    }
}
