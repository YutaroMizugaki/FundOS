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
    uint64 public constant DISSOLUTION_DELAY = 30 days;
    uint64 public constant DISSOLUTION_VALIDITY = 90 days;

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
    error InsufficientAccountingSurplus();
    error FundNotPaused();
    error FundNotActive();
    error DissolutionPending();

    enum GrantStatus {
        None,
        Pending,
        Approved,
        Executed,
        Cancelled,
        Expired
    }

    enum GovernanceStatus {
        None,
        Pending,
        Approved,
        Executed,
        Cancelled
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

    struct YieldAllocation {
        uint256 amount;
        bytes32 evidenceHash;
        string metadataURI;
        address proposer;
        uint64 createdAt;
        uint64 executableAt;
        uint64 expiresAt;
        uint8 approvalCount;
        uint8 approvalThreshold;
        GovernanceStatus status;
    }

    struct DissolutionProposal {
        bytes32 resolutionHash;
        string metadataURI;
        address proposer;
        uint64 createdAt;
        uint64 executableAt;
        uint64 expiresAt;
        uint8 approvalCount;
        uint8 approvalThreshold;
        GovernanceStatus status;
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
    uint256 public nextYieldAllocationId = 1;
    mapping(uint256 => YieldAllocation) public yieldAllocations;
    mapping(uint256 => mapping(address => bool)) public yieldAllocationApprovals;
    DissolutionProposal public dissolution;
    uint256 public dissolutionNonce;
    mapping(uint256 => mapping(address => bool)) public dissolutionApprovals;

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
    event YieldAllocationCreated(
        uint256 indexed allocationId,
        address indexed proposer,
        uint256 amount,
        bytes32 indexed evidenceHash,
        string metadataURI,
        uint64 expiresAt
    );
    event YieldAllocationApproved(
        uint256 indexed allocationId, address indexed approver, uint8 approvalCount
    );
    event YieldAllocationCancelled(uint256 indexed allocationId, address indexed cancelledBy);
    event YieldAllocated(
        uint256 indexed allocationId, address indexed executor, uint256 amount, bytes32 evidenceHash
    );
    event DissolutionInitiated(
        address indexed proposer,
        bytes32 indexed resolutionHash,
        string metadataURI,
        uint64 expiresAt
    );
    event DissolutionApproved(address indexed approver, uint8 approvalCount, uint64 executableAt);
    event DissolutionCancelled(address indexed cancelledBy);
    event FundDissolved(address indexed executor, address indexed recipient, uint256 amount);

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
        if (
            address(constitution_) == address(0) || address(treasury_) == address(0)
                || proposer == address(0) || approver == address(0) || executor == address(0)
                || guardian == address(0) || config == address(0)
        ) revert ZeroAddress();
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

        emit ConfigurationUpdated(
            maxGrantAmount_, requiredApprovals_, timelockDuration_, proposalValidityPeriod_
        );
    }

    /// @notice Creates an attested proposal to reclassify realized yield as grant budget.
    /// @dev The amount must already exist as unaccounted JPYC surplus in the treasury.
    function createYieldAllocation(
        uint256 amount,
        bytes32 evidenceHash,
        string calldata metadataURI
    ) external onlyRole(CONFIG_ROLE) whenNotPaused returns (uint256 allocationId) {
        _requireFundActive();
        if (amount == 0) revert ZeroAmount();
        if (amount > treasury.accountingSurplus()) revert InsufficientAccountingSurplus();

        allocationId = nextYieldAllocationId++;
        uint64 createdAt = uint64(block.timestamp);
        uint64 expiresAt = createdAt + proposalValidityPeriod;
        yieldAllocations[allocationId] = YieldAllocation({
            amount: amount,
            evidenceHash: evidenceHash,
            metadataURI: metadataURI,
            proposer: msg.sender,
            createdAt: createdAt,
            executableAt: 0,
            expiresAt: expiresAt,
            approvalCount: 0,
            approvalThreshold: requiredApprovals,
            status: GovernanceStatus.Pending
        });

        emit YieldAllocationCreated(
            allocationId, msg.sender, amount, evidenceHash, metadataURI, expiresAt
        );
    }

    function approveYieldAllocation(uint256 allocationId)
        external
        onlyRole(APPROVER_ROLE)
        whenNotPaused
    {
        YieldAllocation storage allocation = yieldAllocations[allocationId];
        if (allocation.status == GovernanceStatus.None) revert ProposalNotFound();
        if (allocation.status != GovernanceStatus.Pending) revert InvalidProposalStatus();
        if (block.timestamp > allocation.expiresAt) revert ProposalExpired();
        if (msg.sender == allocation.proposer) revert SelfApprovalForbidden();
        if (yieldAllocationApprovals[allocationId][msg.sender]) revert AlreadyApproved();
        if (allocation.amount > treasury.accountingSurplus()) {
            revert InsufficientAccountingSurplus();
        }

        yieldAllocationApprovals[allocationId][msg.sender] = true;
        allocation.approvalCount += 1;
        emit YieldAllocationApproved(allocationId, msg.sender, allocation.approvalCount);

        if (allocation.approvalCount >= allocation.approvalThreshold) {
            allocation.status = GovernanceStatus.Approved;
            allocation.executableAt = uint64(block.timestamp) + timelockDuration;
        }
    }

    function cancelYieldAllocation(uint256 allocationId) external {
        YieldAllocation storage allocation = yieldAllocations[allocationId];
        if (allocation.status == GovernanceStatus.None) revert ProposalNotFound();
        if (
            allocation.status != GovernanceStatus.Pending
                && allocation.status != GovernanceStatus.Approved
        ) {
            revert InvalidProposalStatus();
        }
        if (
            msg.sender != allocation.proposer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)
                && !hasRole(GUARDIAN_ROLE, msg.sender)
        ) revert UnauthorizedCancellation();

        allocation.status = GovernanceStatus.Cancelled;
        emit YieldAllocationCancelled(allocationId, msg.sender);
    }

    function executeYieldAllocation(uint256 allocationId)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        YieldAllocation storage allocation = yieldAllocations[allocationId];
        if (allocation.status != GovernanceStatus.Approved) revert InvalidProposalStatus();
        if (block.timestamp < allocation.executableAt) revert TimelockNotElapsed();
        if (block.timestamp > allocation.expiresAt) revert ProposalExpired();
        if (allocation.amount > treasury.accountingSurplus()) {
            revert InsufficientAccountingSurplus();
        }

        allocation.status = GovernanceStatus.Executed;
        treasury.recognizeYield(allocation.amount, allocation.evidenceHash);
        emit YieldAllocated(allocationId, msg.sender, allocation.amount, allocation.evidenceHash);
    }

    /// @notice Starts the terminal dissolution process while the fund is paused.
    function initiateDissolution(bytes32 resolutionHash, string calldata metadataURI)
        external
        onlyRole(CONFIG_ROLE)
    {
        _requireFundActive();
        if (!paused() || !treasury.paused()) revert FundNotPaused();
        if (
            dissolution.status == GovernanceStatus.Pending
                || dissolution.status == GovernanceStatus.Approved
        ) {
            revert DissolutionPending();
        }

        uint64 createdAt = uint64(block.timestamp);
        dissolutionNonce += 1;
        dissolution = DissolutionProposal({
            resolutionHash: resolutionHash,
            metadataURI: metadataURI,
            proposer: msg.sender,
            createdAt: createdAt,
            executableAt: 0,
            expiresAt: createdAt + DISSOLUTION_VALIDITY,
            approvalCount: 0,
            approvalThreshold: requiredApprovals,
            status: GovernanceStatus.Pending
        });
        treasury.beginDissolution();

        emit DissolutionInitiated(
            msg.sender, resolutionHash, metadataURI, createdAt + DISSOLUTION_VALIDITY
        );
    }

    function approveDissolution() external onlyRole(APPROVER_ROLE) {
        if (dissolution.status != GovernanceStatus.Pending) revert InvalidProposalStatus();
        if (block.timestamp > dissolution.expiresAt) revert ProposalExpired();
        if (msg.sender == dissolution.proposer) revert SelfApprovalForbidden();
        if (dissolutionApprovals[dissolutionNonce][msg.sender]) revert AlreadyApproved();

        dissolutionApprovals[dissolutionNonce][msg.sender] = true;
        dissolution.approvalCount += 1;

        if (dissolution.approvalCount >= dissolution.approvalThreshold) {
            dissolution.status = GovernanceStatus.Approved;
            dissolution.executableAt = uint64(block.timestamp) + DISSOLUTION_DELAY;
        }
        emit DissolutionApproved(msg.sender, dissolution.approvalCount, dissolution.executableAt);
    }

    function cancelDissolution() external {
        if (
            dissolution.status != GovernanceStatus.Pending
                && dissolution.status != GovernanceStatus.Approved
        ) {
            revert InvalidProposalStatus();
        }
        if (
            msg.sender != dissolution.proposer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)
                && !hasRole(GUARDIAN_ROLE, msg.sender)
        ) revert UnauthorizedCancellation();

        dissolution.status = GovernanceStatus.Cancelled;
        treasury.cancelDissolution();
        emit DissolutionCancelled(msg.sender);
    }

    function executeDissolution() external onlyRole(EXECUTOR_ROLE) nonReentrant {
        if (!paused() || !treasury.paused()) revert FundNotPaused();
        if (dissolution.status != GovernanceStatus.Approved) revert InvalidProposalStatus();
        if (block.timestamp < dissolution.executableAt) revert TimelockNotElapsed();
        if (block.timestamp > dissolution.expiresAt) revert ProposalExpired();

        address recipient = constitution.dissolutionRecipient();
        uint256 amount = treasury.totalTreasuryAssets();
        dissolution.status = GovernanceStatus.Executed;
        treasury.executeDissolution(recipient);
        emit FundDissolved(msg.sender, recipient, amount);
    }

    function createGrantProposal(
        address recipient,
        uint256 amount,
        bytes32 purposeId,
        bytes32 evidenceHash,
        string calldata metadataURI
    ) external onlyRole(PROPOSER_ROLE) returns (uint256 proposalId) {
        _requireFundActive();
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
        _requireFundActive();
        if (
            dissolution.status == GovernanceStatus.Pending
                || dissolution.status == GovernanceStatus.Approved
        ) {
            revert DissolutionPending();
        }
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

    function getYieldAllocation(uint256 allocationId)
        external
        view
        returns (YieldAllocation memory)
    {
        return yieldAllocations[allocationId];
    }

    function getDissolution() external view returns (DissolutionProposal memory) {
        return dissolution;
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

    function _requireFundActive() internal view {
        if (treasury.lifecycle() != TreasuryVault.FundLifecycle.Active) {
            revert FundNotActive();
        }
    }
}
