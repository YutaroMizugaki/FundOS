// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {FundConstitution} from "./FundConstitution.sol";
import {TreasuryVault} from "./TreasuryVault.sol";

/// @title GrantController
/// @notice Manages grant proposals, approvals, timelock, and execution.
contract GrantController is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    uint64 public constant MIN_TIMELOCK_DURATION = 1 days;
    uint64 public constant MIN_PROPOSAL_VALIDITY = 2 days;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient();
    error InvalidConfiguration();
    error ProposalNotFound();
    error InvalidProposalStatus();
    error SelfApprovalForbidden();
    error AlreadyApproved();
    error InsufficientApprovals();
    error TimelockNotElapsed();
    error ProposalExpired();
    error InsufficientGrantBudget();
    error ExceedsMaxGrantAmount();
    error GuardianCannotUnpause();
    error UnauthorizedCancellation();

    enum GrantStatus {
        None,
        Pending,
        Approved,
        Executed,
        Cancelled,
        Expired
    }

    struct GrantProposal {
        address recipient;
        uint256 amount;
        bytes32 purposeId;
        bytes32 evidenceHash;
        string metadataURI;
        uint64 createdAt;
        uint64 executableAt;
        uint64 expiresAt;
        uint8 approvalCount;
        GrantStatus status;
    }

    FundConstitution public immutable constitution;
    TreasuryVault public immutable treasury;

    uint256 public maxGrantAmount;
    uint8 public requiredApprovals;
    uint64 public timelockDuration;
    uint64 public proposalValidityPeriod;

    uint256 public nextProposalId = 1;
    mapping(uint256 => GrantProposal) public proposals;
    mapping(uint256 => address) public proposalProposer;
    mapping(uint256 => mapping(address => bool)) public proposalApprovals;

    event GrantProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed recipient,
        uint256 amount,
        bytes32 purposeId,
        bytes32 evidenceHash,
        string metadataURI,
        uint64 expiresAt
    );
    event GrantProposalApproved(
        uint256 indexed proposalId, address indexed approver, uint8 approvalCount
    );
    event GrantProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy);
    event GrantProposalExecuted(
        uint256 indexed proposalId,
        address indexed executor,
        address indexed recipient,
        uint256 amount
    );
    event ConfigurationUpdated(
        uint256 maxGrantAmount,
        uint8 requiredApprovals,
        uint64 timelockDuration,
        uint64 proposalValidityPeriod
    );
    event FundPaused(address account);
    event FundUnpaused(address account);

    constructor(
        FundConstitution constitution_,
        TreasuryVault treasury_,
        address admin,
        address proposer,
        address approver,
        address executor,
        address guardian,
        address config,
        uint48 adminTransferDelay,
        uint256 maxGrantAmount_,
        uint8 requiredApprovals_,
        uint64 timelockDuration_,
        uint64 proposalValidityPeriod_
    ) AccessControlDefaultAdminRules(adminTransferDelay, admin) {
        if (address(constitution_) == address(0) || address(treasury_) == address(0)) revert ZeroAddress();
        _validateConfiguration(
            maxGrantAmount_, requiredApprovals_, timelockDuration_, proposalValidityPeriod_
        );

        constitution = constitution_;
        treasury = treasury_;
        maxGrantAmount = maxGrantAmount_;
        requiredApprovals = requiredApprovals_;
        timelockDuration = timelockDuration_;
        proposalValidityPeriod = proposalValidityPeriod_;

        _grantRole(PROPOSER_ROLE, proposer);
        _grantRole(APPROVER_ROLE, approver);
        _grantRole(EXECUTOR_ROLE, executor);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(CONFIG_ROLE, config);

        treasury.authorizeGrantController(address(this));

        emit ConfigurationUpdated(
            maxGrantAmount_, requiredApprovals_, timelockDuration_, proposalValidityPeriod_
        );
    }

    function createGrantProposal(
        address recipient,
        uint256 amount,
        bytes32 purposeId,
        bytes32 evidenceHash,
        string calldata metadataURI
    ) external onlyRole(PROPOSER_ROLE) returns (uint256 proposalId) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        if (amount > maxGrantAmount) revert ExceedsMaxGrantAmount();

        proposalId = nextProposalId++;
        uint64 createdAt = uint64(block.timestamp);
        uint64 expiresAt = createdAt + proposalValidityPeriod;

        proposals[proposalId] = GrantProposal({
            recipient: recipient,
            amount: amount,
            purposeId: purposeId,
            evidenceHash: evidenceHash,
            metadataURI: metadataURI,
            createdAt: createdAt,
            executableAt: 0,
            expiresAt: expiresAt,
            approvalCount: 0,
            status: GrantStatus.Pending
        });
        proposalProposer[proposalId] = msg.sender;

        emit GrantProposalCreated(
            proposalId,
            msg.sender,
            recipient,
            amount,
            purposeId,
            evidenceHash,
            metadataURI,
            expiresAt
        );
    }

    function approveGrantProposal(uint256 proposalId)
        external
        onlyRole(APPROVER_ROLE)
        whenNotPaused
    {
        GrantProposal storage proposal = _getProposal(proposalId);
        if (proposal.status != GrantStatus.Pending) revert InvalidProposalStatus();
        if (block.timestamp > proposal.expiresAt) revert ProposalExpired();
        if (msg.sender == proposalProposer[proposalId]) revert SelfApprovalForbidden();
        if (proposalApprovals[proposalId][msg.sender]) revert AlreadyApproved();
        if (proposal.amount > treasury.availableGrantBudget()) revert InsufficientGrantBudget();

        proposalApprovals[proposalId][msg.sender] = true;
        proposal.approvalCount += 1;

        emit GrantProposalApproved(proposalId, msg.sender, proposal.approvalCount);

        if (proposal.approvalCount >= requiredApprovals) {
            proposal.status = GrantStatus.Approved;
            proposal.executableAt = uint64(block.timestamp) + timelockDuration;
        }
    }

    function cancelGrantProposal(uint256 proposalId) external {
        GrantProposal storage proposal = _getProposal(proposalId);
        if (proposal.status != GrantStatus.Pending && proposal.status != GrantStatus.Approved) {
            revert InvalidProposalStatus();
        }

        bool isProposer = msg.sender == proposalProposer[proposalId];
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!isProposer && !isAdmin) revert UnauthorizedCancellation();

        proposal.status = GrantStatus.Cancelled;
        emit GrantProposalCancelled(proposalId, msg.sender);
    }

    function executeGrantProposal(uint256 proposalId)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        GrantProposal storage proposal = _getProposal(proposalId);
        if (proposal.status != GrantStatus.Approved) revert InvalidProposalStatus();
        if (block.timestamp < proposal.executableAt) revert TimelockNotElapsed();
        if (block.timestamp > proposal.expiresAt) revert ProposalExpired();
        if (proposal.amount > treasury.availableGrantBudget()) revert InsufficientGrantBudget();

        proposal.status = GrantStatus.Executed;
        treasury.executeGrantTransfer(proposal.recipient, proposal.amount);

        emit GrantProposalExecuted(proposalId, msg.sender, proposal.recipient, proposal.amount);
    }

    function updateConfiguration(
        uint256 maxGrantAmount_,
        uint8 requiredApprovals_,
        uint64 timelockDuration_,
        uint64 proposalValidityPeriod_
    ) external onlyRole(CONFIG_ROLE) whenNotPaused {
        _validateConfiguration(
            maxGrantAmount_, requiredApprovals_, timelockDuration_, proposalValidityPeriod_
        );
        maxGrantAmount = maxGrantAmount_;
        requiredApprovals = requiredApprovals_;
        timelockDuration = timelockDuration_;
        proposalValidityPeriod = proposalValidityPeriod_;
        emit ConfigurationUpdated(
            maxGrantAmount_, requiredApprovals_, timelockDuration_, proposalValidityPeriod_
        );
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
        treasury.pause();
        emit FundPaused(msg.sender);
    }

    function unpause() external {
        if (
            hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)
                && !hasRole(CONFIG_ROLE, msg.sender)
        ) {
            revert GuardianCannotUnpause();
        }
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(CONFIG_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, DEFAULT_ADMIN_ROLE);
        }
        _unpause();
        treasury.unpause();
        emit FundUnpaused(msg.sender);
    }

    function getProposal(uint256 proposalId) external view returns (GrantProposal memory) {
        return proposals[proposalId];
    }

    function _getProposal(uint256 proposalId)
        internal
        view
        returns (GrantProposal storage proposal)
    {
        proposal = proposals[proposalId];
        if (proposal.status == GrantStatus.None) revert ProposalNotFound();
    }

    function _validateConfiguration(
        uint256 maxGrantAmount_,
        uint8 requiredApprovals_,
        uint64 timelockDuration_,
        uint64 proposalValidityPeriod_
    ) internal pure {
        if (maxGrantAmount_ == 0) revert InvalidConfiguration();
        if (requiredApprovals_ == 0) revert InvalidConfiguration();
        if (timelockDuration_ < MIN_TIMELOCK_DURATION) revert InvalidConfiguration();
        if (proposalValidityPeriod_ <= timelockDuration_) revert InvalidConfiguration();
        if (proposalValidityPeriod_ < MIN_PROPOSAL_VALIDITY) revert InvalidConfiguration();
    }
}
