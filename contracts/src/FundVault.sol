// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFundPolicy} from "./IFundPolicy.sol";

/**
 * @title FundVault
 * @notice On-chain vault for an autonomous / self-driving programmable money fund.
 * @dev Holds native ETH as the demo base asset. Production deployments should wrap ERC-20.
 *
 * Flow:
 *  1. Capitalizers deposit ETH.
 *  2. Anyone (or an off-chain agent via relayer) submits a proposal.
 *  3. The autonomous executor (or anyone, once approved by policy) executes
 *     proposals that pass FundPolicy checks — no multisig required for routine grants.
 */
contract FundVault {
    struct Proposal {
        address recipient;
        uint256 amount;
        bytes32 category;
        string rationale;
        address submitter;
        uint64 submittedAt;
        Status status;
    }

    enum Status {
        Pending,
        Executed,
        Cancelled
    }

    IFundPolicy public immutable policy;
    address public executor;

    uint256 public totalInflows;
    uint256 public totalOutflows;
    uint256 public reserved;
    uint256 public nextProposalId;

    mapping(uint256 => Proposal) public proposals;

    event Deposited(address indexed from, uint256 amount, uint256 nav);
    event ProposalSubmitted(
        uint256 indexed id,
        address indexed recipient,
        uint256 amount,
        bytes32 category
    );
    event ProposalExecuted(uint256 indexed id, address indexed recipient, uint256 amount);
    event ProposalCancelled(uint256 indexed id, string reason);
    event ReserveRebalanced(uint256 reserved, uint256 cash);
    event ExecutorUpdated(address indexed executor);

    error ZeroAmount();
    error ZeroAddress();
    error NotExecutor();
    error InvalidProposal();
    error PolicyRejected(string reason);
    error TransferFailed();

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(address policy_, address executor_) {
        if (policy_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        policy = IFundPolicy(policy_);
        executor = executor_;
    }

    receive() external payable {
        _deposit(msg.sender, msg.value);
    }

    function deposit() external payable {
        _deposit(msg.sender, msg.value);
    }

    function nav() public view returns (uint256) {
        return address(this).balance;
    }

    function cash() public view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal > reserved ? bal - reserved : 0;
    }

    function submitProposal(
        address recipient,
        uint256 amount,
        bytes32 category,
        string calldata rationale
    ) external returns (uint256 id) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        id = nextProposalId++;
        proposals[id] = Proposal({
            recipient: recipient,
            amount: amount,
            category: category,
            rationale: rationale,
            submitter: msg.sender,
            submittedAt: uint64(block.timestamp),
            status: Status.Pending
        });

        emit ProposalSubmitted(id, recipient, amount, category);
    }

    /**
     * @notice Execute a pending proposal if it passes live policy checks.
     * @dev Callable by the designated executor (autonomous agent key / keeper).
     *      Re-validates policy at execution time — programmable money safety.
     */
    function executeProposal(uint256 id) external onlyExecutor {
        Proposal storage p = proposals[id];
        if (p.recipient == address(0) || p.status != Status.Pending) revert InvalidProposal();

        _rebalanceReserve();

        (bool ok, string memory reason) =
            policy.validateDisbursement(p.amount, p.category, nav(), cash());
        if (!ok) revert PolicyRejected(reason);

        p.status = Status.Executed;
        totalOutflows += p.amount;

        (bool sent,) = p.recipient.call{value: p.amount}("");
        if (!sent) revert TransferFailed();

        emit ProposalExecuted(id, p.recipient, p.amount);
        _rebalanceReserve();
    }

    function cancelProposal(uint256 id, string calldata reason) external {
        Proposal storage p = proposals[id];
        if (p.status != Status.Pending) revert InvalidProposal();
        if (msg.sender != p.submitter && msg.sender != executor) revert NotExecutor();
        p.status = Status.Cancelled;
        emit ProposalCancelled(id, reason);
    }

    function rebalanceReserve() external {
        _rebalanceReserve();
    }

    function setExecutor(address newExecutor) external onlyExecutor {
        if (newExecutor == address(0)) revert ZeroAddress();
        executor = newExecutor;
        emit ExecutorUpdated(newExecutor);
    }

    function _deposit(address from, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        totalInflows += amount;
        emit Deposited(from, amount, nav());
        _rebalanceReserve();
    }

    function _rebalanceReserve() internal {
        uint256 bal = address(this).balance;
        uint256 target = (bal * uint256(policy.reserveFloorRatioBps())) / 10_000;
        reserved = target;
        emit ReserveRebalanced(reserved, cash());
    }
}
