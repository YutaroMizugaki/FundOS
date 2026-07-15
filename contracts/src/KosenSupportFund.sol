// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title KosenSupportFund
/// @notice JPYC 高専生活動支援基金 — 拠出・利回り運用・学生への支援を 1 コントラクトで担う最小構成。
/// @dev Polygon 上の JPYC を想定。利回り先は Phase 2 で DEX/LP に差し替え。
contract KosenSupportFund is ERC4626, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev 利回り運用先（レンディング / LP 等）。余剰 JPYC を送る。
    address public yieldSink;

    /// @dev 総資産に対する最低 JPYC 現金比率 (bps)。例: 2000 = 20%。
    uint16 public minCashReserveBps;

    /// @dev 1 回の支援上限 (bps of total assets)。例: 500 = 5%。
    uint16 public maxGrantBps;

    /// @dev 月あたりの支援支出上限（JPYC 単位、18 decimals）。
    uint256 public monthlyGrantCap;

    mapping(address => bool) public grantees;
    mapping(uint256 => uint256) private _monthlyGrantSpend;

    event YieldDeployed(address indexed sink, uint256 amount);
    event StudentSupported(address indexed student, uint256 amount, bytes32 activityRef);
    event GranteeUpdated(address indexed student, bool allowed);
    event YieldSinkUpdated(address indexed sink);

    constructor(
        IERC20 jpyc,
        address admin,
        address executor,
        address yieldSink_,
        uint16 minCashReserveBps_,
        uint16 maxGrantBps_,
        uint256 monthlyGrantCap_
    ) ERC20("Kosen Support Fund", "ksJPYC") ERC4626(jpyc) {
        yieldSink = yieldSink_;
        minCashReserveBps = minCashReserveBps_;
        maxGrantBps = maxGrantBps_;
        monthlyGrantCap = monthlyGrantCap_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURATOR_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, executor);
    }

    /// @notice 活動支援対象の学生ウォレットを登録・解除。
    function setGrantee(address student, bool allowed) external onlyRole(CURATOR_ROLE) {
        grantees[student] = allowed;
        emit GranteeUpdated(student, allowed);
    }

    /// @notice 利回り運用先を更新。
    function setYieldSink(address sink) external onlyRole(DEFAULT_ADMIN_ROLE) {
        yieldSink = sink;
        emit YieldSinkUpdated(sink);
    }

    /// @notice 余剰 JPYC を利回り先へ送る（エージェントが定期実行）。
    function deployYield(uint256 amount) external onlyRole(EXECUTOR_ROLE) whenNotPaused {
        require(yieldSink != address(0), "KosenFund: no yield sink");
        _requireWithinReserve(amount);

        IERC20(asset()).safeTransfer(yieldSink, amount);
        emit YieldDeployed(yieldSink, amount);
    }

    /// @notice 登録済み学生へ活動支援金を送る。
    /// @param activityRef 活動 ID のハッシュ（監査用。例: keccak256("robot-contest-2026")）
    function supportStudent(address student, uint256 amount, bytes32 activityRef)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
    {
        require(grantees[student], "KosenFund: not grantee");
        require(amount > 0, "KosenFund: zero amount");

        uint256 total = totalAssets();
        uint256 maxGrant = (total * maxGrantBps) / 10_000;
        require(amount <= maxGrant, "KosenFund: grant too large");

        uint256 month = _monthIndex(block.timestamp);
        require(_monthlyGrantSpend[month] + amount <= monthlyGrantCap, "KosenFund: monthly cap");

        _requireWithinReserve(amount);

        _monthlyGrantSpend[month] += amount;
        IERC20(asset()).safeTransfer(student, amount);

        emit StudentSupported(student, amount, activityRef);
    }

    function monthlyGrantSpend() external view returns (uint256) {
        return _monthlyGrantSpend[_monthIndex(block.timestamp)];
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
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

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        whenNotPaused
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner);
    }

    /// @dev 現時点ではボルト内 JPYC 残高 = 総資産。Phase 2 で利回りポジションを加算。
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function _requireWithinReserve(uint256 amount) internal view {
        uint256 cash = IERC20(asset()).balanceOf(address(this));
        uint256 total = totalAssets();
        require(total > 0, "KosenFund: empty");

        uint256 minReserve = (total * minCashReserveBps) / 10_000;
        require(cash >= amount && cash - amount >= minReserve, "KosenFund: reserve breach");
    }

    function _monthIndex(uint256 timestamp) private pure returns (uint256) {
        return timestamp / 30 days;
    }
}
