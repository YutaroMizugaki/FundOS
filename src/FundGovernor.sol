// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AutonomousFund} from "./AutonomousFund.sol";

/// @title FundGovernor
/// @notice 自律駆動型基金のガバナンス。寄付者の投票力にもとづく
///         提案 → 投票 → タイムロック → 執行 のライフサイクルを提供する。
///
///  - 投票力は AutonomousFund への寄付額 (1 wei = 1 power) のスナップショット。
///    提案作成後の寄付はその提案の投票に使えないため、駆け込み買収を防ぐ。
///  - 可決された提案はタイムロック期間の経過後にのみ執行でき、
///    その間に guardian や参加者が異常な提案へ対応する猶予が生まれる。
///  - タイムロックは本コントラクト自身が担う (提案は自分自身の call として実行)。
contract FundGovernor {
    // ---------------------------------------------------------------
    // 型定義
    // ---------------------------------------------------------------

    enum ProposalState {
        Pending, // 投票開始待ち
        Active, // 投票受付中
        Defeated, // 否決 (反対多数 or 定足数未達)
        Succeeded, // 可決 (キュー待ち)
        Queued, // タイムロック中
        Executed, // 執行済み
        Cancelled, // 取り下げ
        Expired // 執行猶予切れ
    }

    enum VoteType {
        Against,
        For,
        Abstain
    }

    struct Proposal {
        address proposer;
        uint64 voteStart; // 投票開始時刻 (= スナップショット時刻)
        uint64 voteEnd; // 投票終了時刻
        uint64 eta; // 執行可能になる時刻 (キュー後)
        bool executed;
        bool cancelled;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
    }

    // ---------------------------------------------------------------
    // ストレージ
    // ---------------------------------------------------------------

    AutonomousFund public immutable fund;

    uint64 public immutable votingDelay; // 提案からスナップショット/投票開始までの秒数
    uint64 public immutable votingPeriod; // 投票期間 (秒)
    uint64 public immutable timelockDelay; // 可決から執行可能までの秒数
    uint64 public constant GRACE_PERIOD = 14 days; // キュー後の執行猶予
    uint16 public immutable quorumBps; // 定足数 (総投票力に対する bps)
    uint256 public immutable proposalThreshold; // 提案に必要な投票力 (wei 相当)

    Proposal[] internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------
    // イベント / エラー
    // ---------------------------------------------------------------

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address[] targets,
        uint256[] values,
        bytes[] calldatas,
        string description,
        uint64 voteStart,
        uint64 voteEnd
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteType support, uint256 weight);
    event ProposalQueued(uint256 indexed proposalId, uint64 eta);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);

    error InvalidProposal();
    error BelowProposalThreshold();
    error WrongState(ProposalState actual);
    error AlreadyVoted();
    error NoVotingPower();
    error TimelockNotElapsed();
    error NotProposer();
    error CallReverted(uint256 index);

    // ---------------------------------------------------------------
    // 構築
    // ---------------------------------------------------------------

    constructor(
        AutonomousFund _fund,
        uint64 _votingDelay,
        uint64 _votingPeriod,
        uint64 _timelockDelay,
        uint16 _quorumBps,
        uint256 _proposalThreshold
    ) {
        require(_votingPeriod > 0 && _quorumBps > 0 && _quorumBps <= BPS, "bad params");
        fund = _fund;
        votingDelay = _votingDelay;
        votingPeriod = _votingPeriod;
        timelockDelay = _timelockDelay;
        quorumBps = _quorumBps;
        proposalThreshold = _proposalThreshold;
    }

    receive() external payable {}

    // ---------------------------------------------------------------
    // 提案
    // ---------------------------------------------------------------

    function propose(address[] calldata targets, uint256[] calldata values, bytes[] calldata calldatas, string calldata description)
        external
        returns (uint256 proposalId)
    {
        if (targets.length == 0 || targets.length != values.length || targets.length != calldatas.length) {
            revert InvalidProposal();
        }
        // 直前の時点での投票力で判定 (同一ブロック内の寄付を無効化)
        if (fund.getPowerAt(msg.sender, block.timestamp - 1) < proposalThreshold) {
            revert BelowProposalThreshold();
        }

        proposalId = _proposals.length;
        uint64 voteStart = uint64(block.timestamp) + votingDelay;
        uint64 voteEnd = voteStart + votingPeriod;

        Proposal storage p = _proposals.push();
        p.proposer = msg.sender;
        p.voteStart = voteStart;
        p.voteEnd = voteEnd;
        p.targets = targets;
        p.values = values;
        for (uint256 i = 0; i < calldatas.length; i++) {
            p.calldatas.push(calldatas[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, targets, values, calldatas, description, voteStart, voteEnd);
    }

    /// @notice 提案者による取り下げ。執行前ならいつでも可能。
    function cancel(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (msg.sender != p.proposer) revert NotProposer();
        ProposalState s = state(proposalId);
        if (s == ProposalState.Executed || s == ProposalState.Cancelled) revert WrongState(s);
        p.cancelled = true;
        emit ProposalCancelled(proposalId);
    }

    // ---------------------------------------------------------------
    // 投票
    // ---------------------------------------------------------------

    function castVote(uint256 proposalId, VoteType support) external returns (uint256 weight) {
        Proposal storage p = _proposals[proposalId];
        if (state(proposalId) != ProposalState.Active) revert WrongState(state(proposalId));
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        // スナップショット時点 (voteStart) の投票力を使用
        weight = fund.getPowerAt(msg.sender, p.voteStart);
        if (weight == 0) revert NoVotingPower();

        hasVoted[proposalId][msg.sender] = true;
        if (support == VoteType.For) {
            p.forVotes += weight;
        } else if (support == VoteType.Against) {
            p.againstVotes += weight;
        } else {
            p.abstainVotes += weight;
        }
        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    // ---------------------------------------------------------------
    // キュー / 執行 (タイムロック)
    // ---------------------------------------------------------------

    function queue(uint256 proposalId) external {
        if (state(proposalId) != ProposalState.Succeeded) revert WrongState(state(proposalId));
        Proposal storage p = _proposals[proposalId];
        p.eta = uint64(block.timestamp) + timelockDelay;
        emit ProposalQueued(proposalId, p.eta);
    }

    function execute(uint256 proposalId) external payable {
        if (state(proposalId) != ProposalState.Queued) revert WrongState(state(proposalId));
        Proposal storage p = _proposals[proposalId];
        if (block.timestamp < p.eta) revert TimelockNotElapsed();

        p.executed = true;
        for (uint256 i = 0; i < p.targets.length; i++) {
            (bool ok,) = p.targets[i].call{value: p.values[i]}(p.calldatas[i]);
            if (!ok) revert CallReverted(i);
        }
        emit ProposalExecuted(proposalId);
    }

    // ---------------------------------------------------------------
    // 状態照会
    // ---------------------------------------------------------------

    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        if (p.cancelled) return ProposalState.Cancelled;
        if (p.executed) return ProposalState.Executed;
        if (block.timestamp < p.voteStart) return ProposalState.Pending;
        if (block.timestamp <= p.voteEnd) return ProposalState.Active;

        // 投票終了後
        if (!_succeeded(p)) return ProposalState.Defeated;
        if (p.eta == 0) return ProposalState.Succeeded;
        if (block.timestamp > p.eta + GRACE_PERIOD) return ProposalState.Expired;
        return ProposalState.Queued;
    }

    function _succeeded(Proposal storage p) internal view returns (bool) {
        uint256 quorum = (fund.getTotalPowerAt(p.voteStart) * quorumBps) / BPS;
        return p.forVotes > p.againstVotes && p.forVotes + p.abstainVotes >= quorum;
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function getProposal(uint256 proposalId)
        external
        view
        returns (
            address proposer,
            uint64 voteStart,
            uint64 voteEnd,
            uint64 eta,
            uint256 forVotes,
            uint256 againstVotes,
            uint256 abstainVotes,
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas
        )
    {
        Proposal storage p = _proposals[proposalId];
        return (
            p.proposer, p.voteStart, p.voteEnd, p.eta, p.forVotes, p.againstVotes, p.abstainVotes, p.targets, p.values, p.calldatas
        );
    }
}
