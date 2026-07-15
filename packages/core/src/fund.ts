import { PolicyEngine, type PolicyDecision } from "./policy.js";
import {
  formatUnits,
  monthKey,
  nav,
  parseUnits,
  type Amount,
  type Contributor,
  type DisbursementProposal,
  type FundConfig,
  type FundingRound,
  type FundState,
  type FundStatus,
  type LedgerEntry,
  type Pitch,
  type Timestamp,
  type VoteAllocation,
  type VoteBallot,
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
  /** シード拠出（0 可。以降は contribute で増資） */
  initialDeposit?: Amount;
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

export interface ContributeInput {
  name: string;
  amount: Amount;
  /** 既存拠出者に加算する場合 */
  contributorId?: string;
}

export interface SubmitPitchInput {
  roundId: string;
  studentName: string;
  schoolId: string;
  schoolName: string;
  title: string;
  abstract: string;
  category: string;
  requestedAmount: Amount;
}

export interface SettleResult {
  round: FundingRound;
  pitches: Pitch[];
  executed: DisbursementProposal[];
  rejected: DisbursementProposal[];
}

/**
 * Off-chain programmable vault with contributor voting + student pitches.
 *
 * Flow: contribute (→ voting power) → open round → student pitch → vote → settle
 */
export class FundVault {
  private state: FundState;
  private readonly policy: PolicyEngine;

  private constructor(state: FundState) {
    this.state = state;
    this.policy = new PolicyEngine(state.config, state);
  }

  static create(input: CreateFundInput): FundVault {
    const initialDeposit = input.initialDeposit ?? 0n;
    if (initialDeposit < 0n) {
      throw new Error("initialDeposit must be >= 0");
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
      initialDeposit === 0n
        ? 0n
        : (initialDeposit *
            BigInt(Math.floor(reserveFloorRatio * 1_000_000))) /
          1_000_000n;
    const cash = initialDeposit - reserved;

    const config: FundConfig = {
      id: input.id ?? id("fund"),
      name: input.name,
      mandate: input.mandate,
      reserveFloorRatio,
      maxDisbursementRatio,
      monthlySpendCapRatio,
      decimals: input.decimals ?? 6,
    };

    const ledger: LedgerEntry[] = [];
    if (initialDeposit > 0n) {
      ledger.push({
        id: id("led"),
        at,
        kind: "deposit",
        amount: initialDeposit,
        balanceAfter: initialDeposit,
        memo: "初期シード",
      });
      if (reserved > 0n) {
        ledger.push({
          id: id("led"),
          at,
          kind: "reserve_lock",
          amount: reserved,
          balanceAfter: cash,
          memo: `準備金ロック（${reserveFloorRatio * 100}%）`,
        });
      }
    }

    return new FundVault({
      config,
      status: "active",
      cash,
      reserved,
      createdAt: at,
      proposals: [],
      ledger,
      monthlySpent: {},
      contributors: [],
      pitches: [],
      rounds: [],
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

  /**
   * 拠出 → 投票権付与。
   * 金額と同量の votingPower を付与（1:1）。
   */
  contribute(input: ContributeInput): Contributor {
    this.assertActive();
    if (input.amount <= 0n) throw new Error("contribution must be positive");

    this.applyDeposit(input.amount, `${input.name} による拠出`);

    let contributor: Contributor | undefined;
    if (input.contributorId) {
      contributor = this.state.contributors.find(
        (c) => c.id === input.contributorId,
      );
      if (!contributor) {
        throw new Error(`Unknown contributor: ${input.contributorId}`);
      }
      contributor.contributed += input.amount;
      contributor.votingPower += input.amount;
    } else {
      contributor = {
        id: id("ctrb"),
        name: input.name,
        contributed: input.amount,
        votingPower: input.amount,
        createdAt: now(),
      };
      this.state.contributors.push(contributor);
    }

    this.appendNote(
      `${contributor.name} が ${input.amount} 拠出（投票権 +${input.amount}）`,
      {
        contributorId: contributor.id,
      },
    );
    this.syncPolicy();
    return structuredClone(contributor);
  }

  /** @deprecated Prefer contribute() for voting-power deposits. */
  deposit(amount: Amount, memo = "追加拠出"): void {
    this.assertNotClosed();
    if (amount <= 0n) throw new Error("deposit must be positive");
    this.applyDeposit(amount, memo);
    this.syncPolicy();
  }

  openRound(input: {
    title: string;
    /** 利用可能現金に対する予算比率（既定 0.5） */
    budgetRatio?: number;
    budget?: Amount;
  }): FundingRound {
    this.assertActive();
    const open = this.state.rounds.find((r) => r.status !== "settled");
    if (open) {
      throw new Error(`Round ${open.id} is still ${open.status}`);
    }

    let budget = input.budget;
    if (budget === undefined) {
      const ratio = input.budgetRatio ?? 0.5;
      budget =
        (this.state.cash * BigInt(Math.floor(ratio * 1_000_000))) / 1_000_000n;
    }
    if (budget <= 0n) throw new Error("Round budget must be positive");
    if (budget > this.state.cash) {
      throw new Error("Round budget exceeds available cash");
    }

    const round: FundingRound = {
      id: id("round"),
      title: input.title,
      status: "pitching",
      openedAt: now(),
      budget,
      pitchIds: [],
      ballots: [],
    };
    this.state.rounds.push(round);
    this.appendNote(`ラウンド開始: ${round.title}（予算 ${budget}）`, {
      roundId: round.id,
    });
    return structuredClone(round);
  }

  submitPitch(input: SubmitPitchInput): Pitch {
    this.assertActive();
    const round = this.requireRound(input.roundId);
    if (round.status !== "pitching") {
      throw new Error(`Round is ${round.status}, not accepting pitches`);
    }
    if (input.requestedAmount <= 0n) {
      throw new Error("requestedAmount must be positive");
    }
    if (
      !this.state.config.mandate.allowedCategories.includes(input.category)
    ) {
      throw new Error(`Category outside mandate: ${input.category}`);
    }

    const pitch: Pitch = {
      id: id("pitch"),
      roundId: round.id,
      createdAt: now(),
      studentName: input.studentName,
      schoolId: input.schoolId,
      schoolName: input.schoolName,
      title: input.title,
      abstract: input.abstract,
      category: input.category,
      requestedAmount: input.requestedAmount,
      status: "submitted",
      votesReceived: 0n,
      fundedAmount: 0n,
    };
    this.state.pitches.push(pitch);
    round.pitchIds.push(pitch.id);
    return structuredClone(pitch);
  }

  openVoting(roundId: string): FundingRound {
    this.assertActive();
    const round = this.requireRound(roundId);
    if (round.status !== "pitching") {
      throw new Error(`Round is ${round.status}`);
    }
    if (round.pitchIds.length === 0) {
      throw new Error("Cannot open voting without pitches");
    }
    round.status = "voting";
    round.votingOpenedAt = now();
    this.appendNote(`投票開始: ${round.title}`, { roundId: round.id });
    return structuredClone(round);
  }

  /**
   * 拠出者が投票権をピッチへ配分。
   * 合計 weight は保有 votingPower 以下。同一ラウンドで再投票すると上書き。
   */
  castVote(
    roundId: string,
    contributorId: string,
    allocations: VoteAllocation[],
  ): VoteBallot {
    this.assertActive();
    const round = this.requireRound(roundId);
    if (round.status !== "voting") {
      throw new Error(`Round is ${round.status}, not voting`);
    }
    const contributor = this.state.contributors.find(
      (c) => c.id === contributorId,
    );
    if (!contributor) throw new Error(`Unknown contributor: ${contributorId}`);

    let total = 0n;
    const pitchSet = new Set(round.pitchIds);
    for (const a of allocations) {
      if (a.weight < 0n) throw new Error("Vote weight must be >= 0");
      if (!pitchSet.has(a.pitchId)) {
        throw new Error(`Pitch ${a.pitchId} is not in this round`);
      }
      total += a.weight;
    }
    if (total > contributor.votingPower) {
      throw new Error(
        `Vote exceeds voting power (${total} > ${contributor.votingPower})`,
      );
    }
    if (total === 0n) throw new Error("Ballot must allocate some votes");

    // Remove previous ballot from this contributor in this round
    round.ballots = round.ballots.filter(
      (b) => b.contributorId !== contributorId,
    );

    const ballot: VoteBallot = {
      id: id("ballot"),
      roundId,
      contributorId,
      at: now(),
      allocations: allocations.filter((a) => a.weight > 0n),
    };
    round.ballots.push(ballot);
    this.recomputeVotes(round);
    return structuredClone(ballot);
  }

  /**
   * 投票比重で予算を按分し、ポリシー通過分を執行。
   * payout_i = min(requested_i, budget * votes_i / totalVotes)
   */
  settle(roundId: string): SettleResult {
    this.assertActive();
    const round = this.requireRound(roundId);
    if (round.status !== "voting") {
      throw new Error(`Round is ${round.status}, expected voting`);
    }

    this.recomputeVotes(round);
    const pitches = round.pitchIds
      .map((pid) => this.state.pitches.find((p) => p.id === pid)!)
      .filter(Boolean);

    const totalVotes = pitches.reduce((s, p) => s + p.votesReceived, 0n);
    const executed: DisbursementProposal[] = [];
    const rejected: DisbursementProposal[] = [];

    if (totalVotes === 0n) {
      for (const p of pitches) {
        p.status = "unfunded";
        p.fundedAmount = 0n;
      }
      round.status = "settled";
      round.settledAt = now();
      this.appendNote(`ラウンド確定（票なし）: ${round.title}`, {
        roundId: round.id,
      });
      return {
        round: structuredClone(round),
        pitches: pitches.map((p) => structuredClone(p)),
        executed,
        rejected,
      };
    }

    let remainingBudget = round.budget;

    // Sort by votes desc for deterministic remainder handling
    const ranked = [...pitches].sort((a, b) =>
      b.votesReceived === a.votesReceived
        ? a.id.localeCompare(b.id)
        : b.votesReceived > a.votesReceived
          ? 1
          : -1,
    );

    for (const pitch of ranked) {
      const proportional =
        (round.budget * pitch.votesReceived) / totalVotes;
      let payout =
        proportional < pitch.requestedAmount
          ? proportional
          : pitch.requestedAmount;
      if (payout > remainingBudget) payout = remainingBudget;

      if (payout <= 0n) {
        pitch.status = "unfunded";
        pitch.fundedAmount = 0n;
        continue;
      }

      const proposal = this.submitProposal({
        recipientId: pitch.schoolId,
        recipientName: `${pitch.studentName}（${pitch.schoolName}）`,
        amount: payout,
        category: pitch.category,
        rationale: `ピッチ採択: ${pitch.title}`,
      });
      // Link meta via ledger on execute — store pitch id in rationale is enough for MVP

      const { decision, proposal: decided } = this.autoProcess(proposal.id);
      if (decided.status === "executed") {
        pitch.fundedAmount = payout;
        pitch.status =
          payout >= pitch.requestedAmount ? "funded" : "partial";
        remainingBudget -= payout;
        executed.push(decided);
      } else {
        pitch.fundedAmount = 0n;
        pitch.status = "unfunded";
        rejected.push(decided);
        void decision;
      }
    }

    round.status = "settled";
    round.settledAt = now();
    this.appendNote(
      `ラウンド確定: ${round.title}（執行 ${executed.length} / 却下 ${rejected.length}）`,
      { roundId: round.id },
    );

    return {
      round: structuredClone(round),
      pitches: pitches.map((p) => structuredClone(p)),
      executed,
      rejected,
    };
  }

  currentRound(): FundingRound | undefined {
    const open = this.state.rounds.find((r) => r.status !== "settled");
    return open ? structuredClone(open) : undefined;
  }

  pitchesForRound(roundId: string): Pitch[] {
    return this.state.pitches
      .filter((p) => p.roundId === roundId)
      .map((p) => structuredClone(p));
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

  execute(proposalId: string): DisbursementProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "approved") {
      throw new Error(`Proposal ${proposalId} is not approved`);
    }
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
    const round = this.state.rounds.find((r) => r.status !== "settled");
    return {
      id: this.state.config.id,
      name: this.state.config.name,
      status: this.state.status,
      nav: formatUnits(nav(this.state), decimals),
      cash: formatUnits(this.state.cash, decimals),
      reserved: formatUnits(this.state.reserved, decimals),
      contributors: this.state.contributors.length,
      totalVotingPower: formatUnits(
        this.state.contributors.reduce((s, c) => s + c.votingPower, 0n),
        decimals,
      ),
      pitches: this.state.pitches.length,
      rounds: this.state.rounds.length,
      currentRound: round
        ? { id: round.id, title: round.title, status: round.status }
        : null,
      proposals: this.state.proposals.length,
      pending: this.pendingProposals().length,
      executed: this.state.proposals.filter((p) => p.status === "executed")
        .length,
      mandate: this.state.config.mandate,
    };
  }

  private recomputeVotes(round: FundingRound): void {
    const totals = new Map<string, Amount>();
    for (const pid of round.pitchIds) totals.set(pid, 0n);
    for (const ballot of round.ballots) {
      for (const a of ballot.allocations) {
        totals.set(a.pitchId, (totals.get(a.pitchId) ?? 0n) + a.weight);
      }
    }
    for (const pitch of this.state.pitches) {
      if (pitch.roundId !== round.id) continue;
      pitch.votesReceived = totals.get(pitch.id) ?? 0n;
    }
  }

  private applyDeposit(amount: Amount, memo: string): void {
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
  }

  private requireRound(roundId: string): FundingRound {
    const round = this.state.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error(`Unknown round: ${roundId}`);
    return round;
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

  private assertActive(): void {
    this.assertNotClosed();
    if (this.state.status !== "active") {
      throw new Error(`Fund is ${this.state.status}`);
    }
  }

  private appendNote(memo: string, meta?: Record<string, string>): void {
    this.state.ledger.push({
      id: id("led"),
      at: now(),
      kind: "note",
      amount: 0n,
      balanceAfter: nav(this.state),
      memo,
      meta,
    });
  }

  private syncPolicy(): void {
    this.policy.update(this.state.config, this.state);
  }
}

export { parseUnits, formatUnits, nav };
