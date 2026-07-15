import { PolicyEngine, type PolicyDecision } from "./policy.js";
import {
  formatUnits,
  monthKey,
  nav,
  parseUnits,
  type Amount,
  type DisbursementProposal,
  type FundConfig,
  type FundState,
  type FundStatus,
  type LedgerEntry,
  type Timestamp,
} from "./types.js";

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function now(): Timestamp {
  return new Date().toISOString();
}

export interface CreateFundInput {
  name: string;
  mandate: FundConfig["mandate"];
  reserveFloorRatio?: number;
  maxDisbursementRatio?: number;
  monthlySpendCapRatio?: number;
  initialDeposit: Amount;
  decimals?: number;
  id?: string;
}

export interface SubmitProposalInput {
  recipientId: string;
  recipientName: string;
  amount: Amount;
  category: string;
  rationale: string;
}

/**
 * Off-chain programmable vault: deposits, proposals, policy-gated disbursement.
 */
export class FundVault {
  private state: FundState;
  private readonly policy: PolicyEngine;

  private constructor(state: FundState) {
    this.state = state;
    this.policy = new PolicyEngine(state.config, state);
  }

  static create(input: CreateFundInput): FundVault {
    if (input.initialDeposit <= 0n) {
      throw new Error("initialDeposit must be positive");
    }
    const reserveFloorRatio = input.reserveFloorRatio ?? 0.2;
    const maxDisbursementRatio = input.maxDisbursementRatio ?? 0.05;
    const monthlySpendCapRatio = input.monthlySpendCapRatio ?? 0.1;
    if (
      reserveFloorRatio < 0 ||
      reserveFloorRatio >= 1 ||
      maxDisbursementRatio <= 0 ||
      maxDisbursementRatio > 1 ||
      monthlySpendCapRatio <= 0 ||
      monthlySpendCapRatio > 1
    ) {
      throw new Error("Invalid ratio configuration");
    }

    const at = now();
    const reserved =
      (input.initialDeposit *
        BigInt(Math.floor(reserveFloorRatio * 1_000_000))) /
      1_000_000n;
    const cash = input.initialDeposit - reserved;

    const config: FundConfig = {
      id: input.id ?? id("fund"),
      name: input.name,
      mandate: input.mandate,
      reserveFloorRatio,
      maxDisbursementRatio,
      monthlySpendCapRatio,
      decimals: input.decimals ?? 6,
    };

    const ledger: LedgerEntry[] = [
      {
        id: id("led"),
        at,
        kind: "deposit",
        amount: input.initialDeposit,
        balanceAfter: input.initialDeposit,
        memo: "初期拠出",
      },
      {
        id: id("led"),
        at,
        kind: "reserve_lock",
        amount: reserved,
        balanceAfter: cash,
        memo: `準備金ロック（${reserveFloorRatio * 100}%）`,
      },
    ];

    return new FundVault({
      config,
      status: "active",
      cash,
      reserved,
      createdAt: at,
      proposals: [],
      ledger,
      monthlySpent: {},
    });
  }

  static fromState(state: FundState): FundVault {
    return new FundVault(structuredClone(state));
  }

  getState(): FundState {
    return structuredClone(this.state);
  }

  getConfig(): FundConfig {
    return structuredClone(this.state.config);
  }

  getNav(): Amount {
    return nav(this.state);
  }

  pause(memo = "緊急停止"): void {
    this.assertNotClosed();
    this.state.status = "paused";
    this.appendNote(memo);
    this.syncPolicy();
  }

  resume(memo = "再開"): void {
    if (this.state.status === "closed") {
      throw new Error("Closed fund cannot be resumed");
    }
    this.state.status = "active";
    this.appendNote(memo);
    this.syncPolicy();
  }

  deposit(amount: Amount, memo = "追加拠出"): void {
    this.assertNotClosed();
    if (amount <= 0n) throw new Error("deposit must be positive");
    // Top up reserve toward floor of new NAV, rest to cash.
    const beforeNav = nav(this.state);
    const afterNav = beforeNav + amount;
    const targetReserve =
      (afterNav *
        BigInt(Math.floor(this.state.config.reserveFloorRatio * 1_000_000))) /
      1_000_000n;
    const reserveAdd =
      targetReserve > this.state.reserved
        ? targetReserve - this.state.reserved
        : 0n;
    const cashAdd = amount - reserveAdd;
    this.state.reserved += reserveAdd;
    this.state.cash += cashAdd;
    this.state.ledger.push({
      id: id("led"),
      at: now(),
      kind: "deposit",
      amount,
      balanceAfter: nav(this.state),
      memo,
    });
    if (reserveAdd > 0n) {
      this.state.ledger.push({
        id: id("led"),
        at: now(),
        kind: "reserve_lock",
        amount: reserveAdd,
        balanceAfter: this.state.cash,
        memo: "準備金調整",
      });
    }
    this.syncPolicy();
  }

  submitProposal(input: SubmitProposalInput): DisbursementProposal {
    this.assertNotClosed();
    const proposal: DisbursementProposal = {
      id: id("prop"),
      createdAt: now(),
      recipientId: input.recipientId,
      recipientName: input.recipientName,
      amount: input.amount,
      category: input.category,
      rationale: input.rationale,
      status: "pending",
    };
    this.state.proposals.push(proposal);
    return structuredClone(proposal);
  }

  evaluate(proposalId: string): PolicyDecision {
    const proposal = this.requireProposal(proposalId);
    this.syncPolicy();
    return this.policy.evaluate(proposal);
  }

  /** Approve or reject a pending proposal via policy engine. */
  decide(proposalId: string): PolicyDecision {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "pending") {
      throw new Error(`Proposal ${proposalId} is ${proposal.status}`);
    }
    const decision = this.policy.evaluate(proposal);
    const at = now();
    proposal.decidedAt = at;
    proposal.decisionReason = decision.reason;
    proposal.status = decision.approved ? "approved" : "rejected";
    return decision;
  }

  /** Execute an approved proposal (moves cash, updates monthly spend). */
  execute(proposalId: string): DisbursementProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "approved") {
      throw new Error(`Proposal ${proposalId} is not approved`);
    }
    // Re-check policy at execution time
    const decision = this.policy.evaluate(proposal);
    if (!decision.approved) {
      proposal.status = "rejected";
      proposal.decisionReason = `実行時再評価で却下: ${decision.reason}`;
      proposal.decidedAt = now();
      throw new Error(proposal.decisionReason);
    }
    if (proposal.amount > this.state.cash) {
      throw new Error("Insufficient cash at execution");
    }
    this.state.cash -= proposal.amount;
    const key = monthKey();
    this.state.monthlySpent[key] =
      (this.state.monthlySpent[key] ?? 0n) + proposal.amount;
    proposal.status = "executed";
    proposal.executedAt = now();
    this.state.ledger.push({
      id: id("led"),
      at: proposal.executedAt,
      kind: "disbursement",
      amount: proposal.amount,
      balanceAfter: nav(this.state),
      memo: `${proposal.recipientName}: ${proposal.rationale}`,
      meta: {
        proposalId: proposal.id,
        recipientId: proposal.recipientId,
        category: proposal.category,
      },
    });
    this.syncPolicy();
    return structuredClone(proposal);
  }

  /** Decide + execute in one step when auto-executing. */
  autoProcess(proposalId: string): {
    decision: PolicyDecision;
    proposal: DisbursementProposal;
  } {
    const decision = this.decide(proposalId);
    const proposal = this.requireProposal(proposalId);
    if (decision.approved) {
      this.execute(proposalId);
    }
    return { decision, proposal: structuredClone(proposal) };
  }

  pendingProposals(): DisbursementProposal[] {
    return this.state.proposals.filter((p) => p.status === "pending");
  }

  setStatus(status: FundStatus): void {
    this.state.status = status;
    this.syncPolicy();
  }

  summary() {
    const decimals = this.state.config.decimals ?? 6;
    return {
      id: this.state.config.id,
      name: this.state.config.name,
      status: this.state.status,
      nav: formatUnits(nav(this.state), decimals),
      cash: formatUnits(this.state.cash, decimals),
      reserved: formatUnits(this.state.reserved, decimals),
      proposals: this.state.proposals.length,
      pending: this.pendingProposals().length,
      executed: this.state.proposals.filter((p) => p.status === "executed")
        .length,
      mandate: this.state.config.mandate,
    };
  }

  private requireProposal(proposalId: string): DisbursementProposal {
    const proposal = this.state.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
    return proposal;
  }

  private assertNotClosed(): void {
    if (this.state.status === "closed") {
      throw new Error("Fund is closed");
    }
  }

  private appendNote(memo: string): void {
    this.state.ledger.push({
      id: id("led"),
      at: now(),
      kind: "note",
      amount: 0n,
      balanceAfter: nav(this.state),
      memo,
    });
  }

  private syncPolicy(): void {
    this.policy.update(this.state.config, this.state);
  }
}

export { parseUnits, formatUnits, nav };
