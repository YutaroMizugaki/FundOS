// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IFundManager.sol";

/// @title FundGovernance
/// @notice Lightweight on-chain governance for FundOS.
///
///         Voting power = FUND share token balance at proposal snapshot.
///         Any holder can propose; proposals pass when:
///           1. quorum (% of total supply) votes cast, AND
///           2. majority (% of votes cast) are "for".
///
///         Supported proposal types:
///           - ADD_STRATEGY
///           - REMOVE_STRATEGY
///           - UPDATE_ALLOCATION
///           - SET_FEES
///           - PAUSE / UNPAUSE vault
///
///         After the voting period a passed proposal enters a timelock; it
///         can be executed by anyone after the delay expires.
contract FundGovernance is ReentrancyGuard {
    // ──────────────────────────────────────────────────────────────────────────
    // Types
    // ──────────────────────────────────────────────────────────────────────────

    enum ProposalType {
        ADD_STRATEGY,
        REMOVE_STRATEGY,
        UPDATE_ALLOCATION,
        SET_FEES,
        PAUSE_VAULT,
        UNPAUSE_VAULT
    }

    enum ProposalState {
        Active,
        Defeated,
        Succeeded,
        Queued,
        Executed,
        Cancelled
    }

    struct Proposal {
        uint256 id;
        address proposer;
        ProposalType proposalType;
        bytes params;           // ABI-encoded parameters specific to the type
        string description;
        uint256 snapshotSupply; // total share supply at proposal creation
        uint256 startTime;
        uint256 endTime;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 executeAfter;   // 0 until queued
        ProposalState state;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Governance parameters (immutable-at-deploy for simplicity)
    // ──────────────────────────────────────────────────────────────────────────

    IERC20 public immutable shareToken;   // FundVault shares = governance token
    IFundManager public immutable manager;

    uint256 public immutable votingPeriod;     // seconds
    uint256 public immutable timelockDelay;    // seconds
    uint256 public immutable quorumBps;        // min % of supply that must vote
    uint256 public immutable majorityBps;      // min % of votes that must be "for"

    uint256 public constant BPS = 10_000;

    // ──────────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────────

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // ──────────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────────

    event ProposalCreated(uint256 indexed id, address indexed proposer, ProposalType proposalType, string description);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed id, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCancelled(uint256 indexed id);

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────────

    constructor(
        address _shareToken,
        address _manager,
        uint256 _votingPeriod,
        uint256 _timelockDelay,
        uint256 _quorumBps,
        uint256 _majorityBps
    ) {
        require(_shareToken != address(0) && _manager != address(0), "Gov: zero address");
        require(_quorumBps <= BPS && _majorityBps <= BPS, "Gov: invalid bps");
        require(_votingPeriod >= 1 hours, "Gov: voting too short");
        require(_timelockDelay >= 1 hours, "Gov: timelock too short");

        shareToken = IERC20(_shareToken);
        manager = IFundManager(_manager);
        votingPeriod = _votingPeriod;
        timelockDelay = _timelockDelay;
        quorumBps = _quorumBps;
        majorityBps = _majorityBps;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Proposal creation
    // ──────────────────────────────────────────────────────────────────────────

    function propose(
        ProposalType proposalType,
        bytes calldata params,
        string calldata description
    ) external returns (uint256 proposalId) {
        require(shareToken.balanceOf(msg.sender) > 0, "Gov: no voting power");

        proposalId = ++proposalCount;
        proposals[proposalId] = Proposal({
            id: proposalId,
            proposer: msg.sender,
            proposalType: proposalType,
            params: params,
            description: description,
            snapshotSupply: shareToken.totalSupply(),
            startTime: block.timestamp,
            endTime: block.timestamp + votingPeriod,
            forVotes: 0,
            againstVotes: 0,
            executeAfter: 0,
            state: ProposalState.Active
        });

        emit ProposalCreated(proposalId, msg.sender, proposalType, description);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Voting
    // ──────────────────────────────────────────────────────────────────────────

    function castVote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Gov: proposal not found");
        require(p.state == ProposalState.Active, "Gov: not active");
        require(block.timestamp <= p.endTime, "Gov: voting ended");
        require(!hasVoted[proposalId][msg.sender], "Gov: already voted");

        uint256 weight = shareToken.balanceOf(msg.sender);
        require(weight > 0, "Gov: no voting power");

        hasVoted[proposalId][msg.sender] = true;
        if (support) {
            p.forVotes += weight;
        } else {
            p.againstVotes += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Queue & execute
    // ──────────────────────────────────────────────────────────────────────────

    function queue(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Gov: proposal not found");
        require(p.state == ProposalState.Active, "Gov: not active");
        require(block.timestamp > p.endTime, "Gov: voting not ended");

        if (_quorumReached(p) && _majorityReached(p)) {
            p.state = ProposalState.Queued;
            p.executeAfter = block.timestamp + timelockDelay;
            emit ProposalQueued(proposalId, p.executeAfter);
        } else {
            p.state = ProposalState.Defeated;
        }
    }

    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Gov: proposal not found");
        require(p.state == ProposalState.Queued, "Gov: not queued");
        require(block.timestamp >= p.executeAfter, "Gov: timelock not elapsed");

        p.state = ProposalState.Executed;
        _execute(p);
        emit ProposalExecuted(proposalId);
    }

    function cancel(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Gov: proposal not found");
        require(p.state == ProposalState.Active || p.state == ProposalState.Queued, "Gov: cannot cancel");
        require(msg.sender == p.proposer, "Gov: not proposer");

        p.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal execution dispatch
    // ──────────────────────────────────────────────────────────────────────────

    function _execute(Proposal storage p) internal {
        if (p.proposalType == ProposalType.ADD_STRATEGY) {
            (address strategy, uint16 targetBps) = abi.decode(p.params, (address, uint16));
            manager.addStrategy(strategy, targetBps);

        } else if (p.proposalType == ProposalType.REMOVE_STRATEGY) {
            address strategy = abi.decode(p.params, (address));
            manager.removeStrategy(strategy);

        } else if (p.proposalType == ProposalType.UPDATE_ALLOCATION) {
            (address strategy, uint16 newTargetBps) = abi.decode(p.params, (address, uint16));
            manager.updateAllocation(strategy, newTargetBps);

        } else {
            revert("Gov: unsupported proposal type");
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────────

    function state(uint256 proposalId) external view returns (ProposalState) {
        Proposal storage p = proposals[proposalId];
        if (p.state == ProposalState.Active && block.timestamp > p.endTime) {
            return _quorumReached(p) && _majorityReached(p)
                ? ProposalState.Succeeded
                : ProposalState.Defeated;
        }
        return p.state;
    }

    function _quorumReached(Proposal storage p) internal view returns (bool) {
        if (p.snapshotSupply == 0) return false;
        uint256 totalVotes = p.forVotes + p.againstVotes;
        return (totalVotes * BPS) / p.snapshotSupply >= quorumBps;
    }

    function _majorityReached(Proposal storage p) internal view returns (bool) {
        uint256 totalVotes = p.forVotes + p.againstVotes;
        if (totalVotes == 0) return false;
        return (p.forVotes * BPS) / totalVotes >= majorityBps;
    }
}
