// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AutonomousFund
/// @notice プログラマブルマネーによる自律駆動型基金の金庫(トレジャリー)。
///
/// 仕組み:
///  - 誰でも ETH を寄付でき、寄付額に比例した投票力(1 wei = 1 power)を得る。
///    寄付は取り消し不可のため、投票力の取得には実コストが伴う。
///  - ガバナンス(governor)が「助成プログラム」を定義すると、以後の支払いは
///    人手を介さず、誰でも `executeGrant` を呼ぶことで期日どおりに執行される。
///    実行者にはキーパー報酬が支払われるため、基金は自律的に駆動し続ける。
///  - エポックごとの支出上限(トレジャリー残高に対する bps)がプロトコル層で
///    強制されるため、ガバナンスが乗っ取られても一度に流出する額は制限される。
///  - guardian は緊急停止(pause)のみ可能で、資金を動かす権限は持たない。
contract AutonomousFund {
    // ---------------------------------------------------------------
    // 型定義
    // ---------------------------------------------------------------

    struct Grant {
        address recipient; // 受給者
        uint96 amountPerPeriod; // 1 期あたりの支給額 (wei)
        uint64 nextRelease; // 次回支給が可能になる時刻
        uint32 period; // 支給間隔 (秒)
        uint32 periodsLeft; // 残り支給回数
        bool active;
    }

    struct Checkpoint {
        uint64 ts;
        uint192 power;
    }

    // ---------------------------------------------------------------
    // ストレージ
    // ---------------------------------------------------------------

    address public governor;
    address public guardian;
    bool public paused;

    /// @notice エポック長 (秒)。支出上限の集計単位。
    uint64 public immutable epochLength;
    /// @notice デプロイ時刻。エポック番号の基準。
    uint64 public immutable genesis;
    /// @notice 1 エポックに支出できる、エポック開始時残高に対する割合 (bps)。
    uint16 public epochCapBps;
    /// @notice 助成執行者へ支払う報酬 (支給額に対する bps)。
    uint16 public keeperBountyBps;

    uint64 internal _epochIndex; // 最後に精算したエポック番号
    uint256 internal _epochBudget; // 当該エポックの支出上限額 (wei)
    uint256 internal _epochSpent; // 当該エポックの支出済み額 (wei)

    Grant[] internal _grants;

    mapping(address => Checkpoint[]) internal _powerCheckpoints;
    Checkpoint[] internal _totalPowerCheckpoints;
    mapping(address => uint256) public totalDonated;

    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------
    // イベント / エラー
    // ---------------------------------------------------------------

    event Donated(address indexed donor, uint256 amount, uint256 newPower);
    event GrantCreated(
        uint256 indexed grantId,
        address indexed recipient,
        uint256 amountPerPeriod,
        uint32 period,
        uint32 numPeriods,
        uint64 firstRelease
    );
    event GrantExecuted(
        uint256 indexed grantId, address indexed recipient, uint256 amount, uint32 periodsReleased, address keeper, uint256 bounty
    );
    event GrantCancelled(uint256 indexed grantId);
    event TransferredOut(address indexed to, uint256 amount);
    event Paused(address by);
    event Unpaused(address by);
    event GovernorUpdated(address indexed newGovernor);
    event GuardianUpdated(address indexed newGuardian);
    event EpochCapUpdated(uint16 newCapBps);
    event KeeperBountyUpdated(uint16 newBountyBps);
    event EpochRolled(uint64 indexed epochIndex, uint256 budget);

    error NotGovernor();
    error NotGuardianOrGovernor();
    error IsPaused();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidParams();
    error GrantNotActive();
    error NothingDue();
    error EpochCapExceeded(uint256 requested, uint256 remaining);
    error TransferFailed();

    // ---------------------------------------------------------------
    // 修飾子
    // ---------------------------------------------------------------

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    // ---------------------------------------------------------------
    // 構築
    // ---------------------------------------------------------------

    constructor(address _governor, address _guardian, uint64 _epochLength, uint16 _epochCapBps, uint16 _keeperBountyBps) {
        if (_governor == address(0)) revert ZeroAddress();
        if (_epochLength == 0 || _epochCapBps == 0 || _epochCapBps > BPS || _keeperBountyBps > 500) {
            revert InvalidParams();
        }
        governor = _governor;
        guardian = _guardian;
        epochLength = _epochLength;
        genesis = uint64(block.timestamp);
        epochCapBps = _epochCapBps;
        keeperBountyBps = _keeperBountyBps;
        _epochIndex = type(uint64).max; // 未精算を示す番兵値
    }

    // ---------------------------------------------------------------
    // 寄付 (投票力の獲得)
    // ---------------------------------------------------------------

    receive() external payable {
        _donate(msg.sender, msg.value);
    }

    function donate() external payable {
        _donate(msg.sender, msg.value);
    }

    /// @notice 第三者(受益者)名義で寄付する。
    function donateFor(address beneficiary) external payable {
        if (beneficiary == address(0)) revert ZeroAddress();
        _donate(beneficiary, msg.value);
    }

    function _donate(address donor, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        totalDonated[donor] += amount;
        uint256 newPower = _pushCheckpoint(_powerCheckpoints[donor], amount);
        _pushCheckpoint(_totalPowerCheckpoints, amount);
        emit Donated(donor, amount, newPower);
    }

    // ---------------------------------------------------------------
    // 投票力の照会 (チェックポイント方式)
    // ---------------------------------------------------------------

    function powerOf(address account) external view returns (uint256) {
        Checkpoint[] storage cps = _powerCheckpoints[account];
        return cps.length == 0 ? 0 : cps[cps.length - 1].power;
    }

    function totalPower() external view returns (uint256) {
        Checkpoint[] storage cps = _totalPowerCheckpoints;
        return cps.length == 0 ? 0 : cps[cps.length - 1].power;
    }

    /// @notice 指定時刻における投票力 (スナップショット投票用)。
    function getPowerAt(address account, uint256 ts) external view returns (uint256) {
        return _checkpointAt(_powerCheckpoints[account], ts);
    }

    function getTotalPowerAt(uint256 ts) external view returns (uint256) {
        return _checkpointAt(_totalPowerCheckpoints, ts);
    }

    function _pushCheckpoint(Checkpoint[] storage cps, uint256 delta) internal returns (uint256 newPower) {
        uint256 prev = cps.length == 0 ? 0 : cps[cps.length - 1].power;
        newPower = prev + delta;
        if (cps.length > 0 && cps[cps.length - 1].ts == uint64(block.timestamp)) {
            cps[cps.length - 1].power = uint192(newPower);
        } else {
            cps.push(Checkpoint({ts: uint64(block.timestamp), power: uint192(newPower)}));
        }
    }

    function _checkpointAt(Checkpoint[] storage cps, uint256 ts) internal view returns (uint256) {
        uint256 len = cps.length;
        if (len == 0 || cps[0].ts > ts) return 0;
        // 二分探索: ts 以前で最後のチェックポイントを探す
        uint256 lo = 0;
        uint256 hi = len - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (cps[mid].ts <= ts) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return cps[lo].power;
    }

    // ---------------------------------------------------------------
    // 助成プログラム (プログラマブルな支出ポリシー)
    // ---------------------------------------------------------------

    /// @notice 定期支給の助成プログラムを作成する。ガバナンス経由でのみ可能。
    function createGrant(address recipient, uint96 amountPerPeriod, uint32 period, uint32 numPeriods, uint64 firstRelease)
        external
        onlyGovernor
        returns (uint256 grantId)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountPerPeriod == 0 || period == 0 || numPeriods == 0) revert InvalidParams();
        if (firstRelease < block.timestamp) firstRelease = uint64(block.timestamp);

        grantId = _grants.length;
        _grants.push(
            Grant({
                recipient: recipient,
                amountPerPeriod: amountPerPeriod,
                nextRelease: firstRelease,
                period: period,
                periodsLeft: numPeriods,
                active: true
            })
        );
        emit GrantCreated(grantId, recipient, amountPerPeriod, period, numPeriods, firstRelease);
    }

    /// @notice 助成を停止する。governor または guardian のみ。
    function cancelGrant(uint256 grantId) external {
        if (msg.sender != governor && msg.sender != guardian) revert NotGuardianOrGovernor();
        Grant storage g = _grants[grantId];
        if (!g.active) revert GrantNotActive();
        g.active = false;
        emit GrantCancelled(grantId);
    }

    /// @notice 期日が到来した助成を執行する。誰でも呼び出せる (パーミッションレス)。
    ///         未執行の期があればまとめて支給し、実行者にはキーパー報酬を支払う。
    function executeGrant(uint256 grantId) external whenNotPaused returns (uint256 amountPaid) {
        Grant storage g = _grants[grantId];
        if (!g.active) revert GrantNotActive();
        if (block.timestamp < g.nextRelease) revert NothingDue();

        // 到来済みの期数 (未執行分をまとめて精算)
        uint256 due = 1 + (block.timestamp - g.nextRelease) / g.period;
        if (due > g.periodsLeft) due = g.periodsLeft;

        amountPaid = due * uint256(g.amountPerPeriod);
        uint256 bounty = (amountPaid * keeperBountyBps) / BPS;

        g.periodsLeft -= uint32(due);
        g.nextRelease += uint64(due * g.period);
        if (g.periodsLeft == 0) g.active = false;

        _spend(g.recipient, amountPaid);
        if (bounty > 0) _spend(msg.sender, bounty);

        emit GrantExecuted(grantId, g.recipient, amountPaid, uint32(due), msg.sender, bounty);
    }

    function grantCount() external view returns (uint256) {
        return _grants.length;
    }

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return _grants[grantId];
    }

    /// @notice 執行可能な助成があるか (キーパー/Chainlink Automation 用チェック)。
    function grantDue(uint256 grantId) external view returns (bool) {
        Grant storage g = _grants[grantId];
        return g.active && !paused && block.timestamp >= g.nextRelease;
    }

    // ---------------------------------------------------------------
    // ガバナンス承認による単発送金
    // ---------------------------------------------------------------

    /// @notice 単発の支出。ガバナンスの議決を経て governor から呼ばれる。
    function transferOut(address to, uint256 amount) external onlyGovernor whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _spend(to, amount);
        emit TransferredOut(to, amount);
    }

    // ---------------------------------------------------------------
    // エポック支出上限 (プロトコル層のセーフガード)
    // ---------------------------------------------------------------

    function currentEpoch() public view returns (uint64) {
        return uint64((block.timestamp - genesis) / epochLength);
    }

    /// @notice 現在のエポックで残っている支出可能額。
    function epochRemaining() external view returns (uint256) {
        if (currentEpoch() != _epochIndex) {
            return (address(this).balance * epochCapBps) / BPS;
        }
        return _epochBudget - _epochSpent;
    }

    function _spend(address to, uint256 amount) internal {
        _rollEpoch();
        uint256 remaining = _epochBudget - _epochSpent;
        if (amount > remaining) revert EpochCapExceeded(amount, remaining);
        _epochSpent += amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _rollEpoch() internal {
        uint64 epoch = currentEpoch();
        if (epoch != _epochIndex) {
            _epochIndex = epoch;
            _epochBudget = (address(this).balance * epochCapBps) / BPS;
            _epochSpent = 0;
            emit EpochRolled(epoch, _epochBudget);
        }
    }

    // ---------------------------------------------------------------
    // 管理 (すべてガバナンス経由)
    // ---------------------------------------------------------------

    function setGovernor(address newGovernor) external onlyGovernor {
        if (newGovernor == address(0)) revert ZeroAddress();
        governor = newGovernor;
        emit GovernorUpdated(newGovernor);
    }

    function setGuardian(address newGuardian) external onlyGovernor {
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    function setEpochCapBps(uint16 newCapBps) external onlyGovernor {
        if (newCapBps == 0 || newCapBps > BPS) revert InvalidParams();
        epochCapBps = newCapBps;
        emit EpochCapUpdated(newCapBps);
    }

    function setKeeperBountyBps(uint16 newBountyBps) external onlyGovernor {
        if (newBountyBps > 500) revert InvalidParams();
        keeperBountyBps = newBountyBps;
        emit KeeperBountyUpdated(newBountyBps);
    }

    /// @notice 緊急停止。guardian または governor のみ。
    function pause() external {
        if (msg.sender != governor && msg.sender != guardian) revert NotGuardianOrGovernor();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice 停止解除はガバナンスのみ。
    function unpause() external onlyGovernor {
        paused = false;
        emit Unpaused(msg.sender);
    }
}
