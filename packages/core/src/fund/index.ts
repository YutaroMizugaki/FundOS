import { randomUUID } from "node:crypto";
import { FundLedger } from "../ledger/index.js";
import { PolicyEngine, defaultPolicies } from "../policy/index.js";
import {
  availableCash,
  nav,
  type DisbursementProposal,
  type FundConfig,
  type FundMandate,
  type FundSnapshot,
  type FundState,
  type FundStatus,
  type PolicyDecision,
  type PolicyRule,
  type Timestamp,
  type TrackedProposal,
} from "../types/index.js";

function now(): Timestamp {
  return new Date().toISOString();
}

export interface CreateFundInput {
  id?: string;
  name: string;
  baseAsset?: string;
  mandate: FundMandate;
  /** Default 0.20 (20%). */
  reserveFloorRatio?: number;
  /** Default 0.05 (5%). */
  maxDisbursementRatio?: number;
  policies?: PolicyRule[];
  initialDeposit?: bigint;
}

/**
 * In-memory programmable fund vault.
 * Mirrors on-chain FundVault semantics for local simulation & agent loops.
 */
export class FundVault {
  readonly config: FundConfig;
  private state: FundState;
  private proposals: TrackedProposal[] = [];
  private readonly ledger: FundLedger;
  private readonly engine: PolicyEngine;
  private policies: PolicyRule[];

  private constructor(
    config: FundConfig,
    state: FundState,
    policies: PolicyRule[],
    ledger: FundLedger,
  ) {
    this.config = config;
    this.state = state;
    this.policies = policies;
    this.ledger = ledger;
    this.engine = new PolicyEngine({ config, state, policies });
  }

  static create(input: CreateFundInput): FundVault {
    const createdAt = now();
    const config: FundConfig = {
      id: input.id ?? randomUUID(),
      name: input.name,
      baseAsset: input.baseAsset ?? "USDC",
      mandate: input.mandate,
      reserveFloorRatio: input.reserveFloorRatio ?? 0.2,
      maxDisbursementRatio: input.maxDisbursementRatio ?? 0.05,
      createdAt,
    };

    const deposit = input.initialDeposit ?? 0n;
    const targetReserve =
      (deposit *
        BigInt(Math.floor(config.reserveFloorRatio * 1_000_000))) /
      1_000_000n;

    const state: FundState = {
      status: deposit > 0n ? "active" : "draft",
      cash: deposit - targetReserve,
      reserved: targetReserve,
      totalInflows: deposit,
      totalOutflows: 0n,
      updatedAt: createdAt,
    };

    const policies = input.policies ?? defaultPolicies();
    const ledger = new FundLedger();
    const vault = new FundVault(config, state, policies, ledger);

    if (deposit > 0n) {
      ledger.append({
        fundId: config.id,
        kind: "deposit",
        amount: deposit,
        note: `Initial capitalization of ${deposit} ${config.baseAsset}`,
        at: createdAt,
      });
      ledger.append({
        fundId: config.id,
        kind: "reserve_lock",
        amount: targetReserve,
        note: `Locked reserve floor ${config.reserveFloorRatio * 100}%`,
        at: createdAt,
      });
      ledger.append({
        fundId: config.id,
        kind: "status_change",
        note: "Fund activated on initial deposit",
        at: createdAt,
        payload: { status: "active" },
      });
    }

    return vault;
  }

  getState(): FundState {
    return { ...this.state };
  }

  getNav(): bigint {
    return nav(this.state);
  }

  getAvailableCash(): bigint {
    return availableCash(this.state);
  }

  getProposals(): readonly TrackedProposal[] {
    return this.proposals;
  }

  getPolicies(): readonly PolicyRule[] {
    return this.policies;
  }

  getLedger() {
    return this.ledger;
  }

  getPolicyEngine(): PolicyEngine {
    this.engine.updateContext({
      config: this.config,
      state: this.state,
      policies: this.policies,
    });
    return this.engine;
  }

  setStatus(status: FundStatus, reason: string): void {
    const prev = this.state.status;
    this.state = { ...this.state, status, updatedAt: now() };
    this.ledger.append({
      fundId: this.config.id,
      kind: "status_change",
      note: reason,
      payload: { from: prev, to: status },
    });
  }

  deposit(amount: bigint, from = "capitalizer"): void {
    if (amount <= 0n) throw new Error("Deposit amount must be positive");
    const at = now();
    this.state = {
      ...this.state,
      cash: this.state.cash + amount,
      totalInflows: this.state.totalInflows + amount,
      status: this.state.status === "draft" ? "active" : this.state.status,
      updatedAt: at,
    };
    this.ledger.append({
      fundId: this.config.id,
      kind: "deposit",
      amount,
      counterparty: from,
      note: `Deposit ${amount} ${this.config.baseAsset} from ${from}`,
      at,
    });
    this.rebalanceReserve("Post-deposit reserve rebalance");
  }

  submitProposal(
    input: Omit<DisbursementProposal, "id" | "submittedAt"> & { id?: string },
  ): TrackedProposal {
    const proposal: TrackedProposal = {
      id: input.id ?? randomUUID(),
      recipient: input.recipient,
      amount: input.amount,
      category: input.category,
      rationale: input.rationale,
      submittedAt: now(),
      metadata: input.metadata,
      status: "pending",
    };
    this.proposals.push(proposal);
    this.ledger.append({
      fundId: this.config.id,
      kind: "policy_decision",
      proposalId: proposal.id,
      amount: proposal.amount,
      counterparty: proposal.recipient,
      note: `Proposal submitted: ${proposal.rationale}`,
      payload: { status: "pending", category: proposal.category },
    });
    return proposal;
  }

  evaluateProposal(proposalId: string): PolicyDecision {
    const proposal = this.requireProposal(proposalId);
    const decision = this.getPolicyEngine().evaluateProposal(proposal);
    this.ledger.append({
      fundId: this.config.id,
      kind: "policy_decision",
      proposalId,
      amount: proposal.amount,
      note: decision.approved
        ? "Policy engine approved proposal"
        : `Policy engine rejected: ${decision.reasons.join("; ")}`,
      payload: {
        approved: decision.approved,
        reasons: decision.reasons,
        checks: decision.checks,
      },
    });
    return decision;
  }

  approveProposal(proposalId: string, reason: string): TrackedProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "pending") {
      throw new Error(`Proposal ${proposalId} is ${proposal.status}, not pending`);
    }
    const decision = this.evaluateProposal(proposalId);
    if (!decision.approved) {
      return this.rejectProposal(
        proposalId,
        `Auto-reject on failed policy: ${decision.reasons.join("; ")}`,
      );
    }
    proposal.status = "approved";
    proposal.decisionReason = reason;
    proposal.decidedAt = now();
    this.ledger.append({
      fundId: this.config.id,
      kind: "policy_decision",
      proposalId,
      note: `Approved: ${reason}`,
      payload: { status: "approved" },
    });
    return proposal;
  }

  rejectProposal(proposalId: string, reason: string): TrackedProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "pending" && proposal.status !== "approved") {
      throw new Error(`Cannot reject proposal in status ${proposal.status}`);
    }
    proposal.status = "rejected";
    proposal.decisionReason = reason;
    proposal.decidedAt = now();
    this.ledger.append({
      fundId: this.config.id,
      kind: "policy_decision",
      proposalId,
      note: `Rejected: ${reason}`,
      payload: { status: "rejected" },
    });
    return proposal;
  }

  executeProposal(proposalId: string): TrackedProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "approved") {
      throw new Error(`Proposal ${proposalId} must be approved before execution`);
    }
    // Re-check policies at execution time (autonomous safety)
    const decision = this.getPolicyEngine().evaluateProposal(proposal);
    if (!decision.approved) {
      proposal.status = "rejected";
      proposal.decisionReason = `Execution blocked: ${decision.reasons.join("; ")}`;
      proposal.decidedAt = now();
      throw new Error(proposal.decisionReason);
    }
    if (proposal.amount > this.state.cash) {
      throw new Error("Insufficient cash at execution");
    }

    const at = now();
    this.state = {
      ...this.state,
      cash: this.state.cash - proposal.amount,
      totalOutflows: this.state.totalOutflows + proposal.amount,
      updatedAt: at,
    };
    proposal.status = "executed";
    proposal.executedAt = at;
    proposal.txRef = `local:${randomUUID()}`;

    this.ledger.append({
      fundId: this.config.id,
      kind: "disbursement",
      amount: proposal.amount,
      counterparty: proposal.recipient,
      proposalId,
      note: `Disbursed ${proposal.amount} to ${proposal.recipient}`,
      at,
      payload: { txRef: proposal.txRef, category: proposal.category },
    });

    this.rebalanceReserve("Post-disbursement reserve rebalance");
    return proposal;
  }

  /** Move cash ↔ reserved to match reserve floor target. */
  rebalanceReserve(note = "Reserve rebalance"): void {
    const target = this.getPolicyEngine().targetReserved();
    const current = this.state.reserved;
    const at = now();

    if (target === current) return;

    if (target > current) {
      const need = target - current;
      const lock = need <= this.state.cash ? need : this.state.cash;
      if (lock === 0n) return;
      this.state = {
        ...this.state,
        cash: this.state.cash - lock,
        reserved: this.state.reserved + lock,
        updatedAt: at,
      };
      this.ledger.append({
        fundId: this.config.id,
        kind: "reserve_lock",
        amount: lock,
        note,
        at,
      });
    } else {
      const release = current - target;
      this.state = {
        ...this.state,
        cash: this.state.cash + release,
        reserved: this.state.reserved - release,
        updatedAt: at,
      };
      this.ledger.append({
        fundId: this.config.id,
        kind: "reserve_release",
        amount: release,
        note,
        at,
      });
    }
  }

  snapshot(): FundSnapshot {
    return {
      config: { ...this.config },
      state: this.getState(),
      proposals: this.proposals.map((p) => ({ ...p })),
      policies: this.policies.map((p) => ({ ...p })),
      ledger: this.ledger.serialize(),
    };
  }

  private requireProposal(id: string): TrackedProposal {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`Proposal not found: ${id}`);
    return p;
  }
}

/** Format base units (6 decimals) as human-readable. */
export function formatUnits(amount: bigint, decimals = 6): string {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac.length ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function parseUnits(value: string, decimals = 6): bigint {
  const [whole, frac = ""] = value.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + fracPadded);
}
