/** Smallest currency unit (e.g. USDC micro-units = 6 decimals). */
export type Amount = bigint;

export type Timestamp = string;

export type FundStatus = "active" | "paused" | "closed";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "cancelled";

export type RoundStatus = "pitching" | "voting" | "settled";

export type PitchStatus =
  | "submitted"
  | "funded"
  | "partial"
  | "unfunded"
  | "withdrawn";

export interface Mandate {
  /** Human-readable purpose of the fund. */
  purpose: string;
  /** Allowed grant categories (e.g. equipment, scholarship, research). */
  allowedCategories: string[];
  /** Optional geographic / institutional scope label. */
  scope?: string;
}

export interface FundConfig {
  id: string;
  name: string;
  mandate: Mandate;
  /** Fraction of NAV that must remain as reserve (0–1). */
  reserveFloorRatio: number;
  /** Max single disbursement as fraction of NAV (0–1). */
  maxDisbursementRatio: number;
  /** Max total disbursements per calendar month as fraction of NAV (0–1). */
  monthlySpendCapRatio: number;
  /** Asset decimals for display (default 6). */
  decimals?: number;
}

export interface LedgerEntry {
  id: string;
  at: Timestamp;
  kind:
    | "deposit"
    | "disbursement"
    | "reserve_lock"
    | "reserve_release"
    | "note";
  amount: Amount;
  balanceAfter: Amount;
  memo: string;
  meta?: Record<string, string>;
}

export interface DisbursementProposal {
  id: string;
  createdAt: Timestamp;
  recipientId: string;
  recipientName: string;
  amount: Amount;
  category: string;
  rationale: string;
  status: ProposalStatus;
  decisionReason?: string;
  decidedAt?: Timestamp;
  executedAt?: Timestamp;
}

/** 拠出者 — 拠出額に応じて投票権を持つ */
export interface Contributor {
  id: string;
  name: string;
  contributed: Amount;
  /** 1 最小単位の拠出 = 1 投票権（MVP） */
  votingPower: Amount;
  createdAt: Timestamp;
}

/** 学生プレゼン（ピッチ） */
export interface Pitch {
  id: string;
  roundId: string;
  createdAt: Timestamp;
  studentName: string;
  /** 所属高専など */
  schoolId: string;
  schoolName: string;
  title: string;
  /** プレゼン要旨 */
  abstract: string;
  category: string;
  requestedAmount: Amount;
  status: PitchStatus;
  votesReceived: Amount;
  fundedAmount: Amount;
}

export interface VoteAllocation {
  pitchId: string;
  weight: Amount;
}

export interface VoteBallot {
  id: string;
  roundId: string;
  contributorId: string;
  at: Timestamp;
  allocations: VoteAllocation[];
}

export interface FundingRound {
  id: string;
  title: string;
  status: RoundStatus;
  openedAt: Timestamp;
  votingOpenedAt?: Timestamp;
  settledAt?: Timestamp;
  /** このラウンドで配分可能な予算上限 */
  budget: Amount;
  pitchIds: string[];
  ballots: VoteBallot[];
}

export interface FundState {
  config: FundConfig;
  status: FundStatus;
  cash: Amount;
  reserved: Amount;
  createdAt: Timestamp;
  proposals: DisbursementProposal[];
  ledger: LedgerEntry[];
  /** ISO month key → amount spent that month. */
  monthlySpent: Record<string, Amount>;
  contributors: Contributor[];
  pitches: Pitch[];
  rounds: FundingRound[];
}

export function monthKey(iso: Timestamp = new Date().toISOString()): string {
  return iso.slice(0, 7);
}

export function nav(state: Pick<FundState, "cash" | "reserved">): Amount {
  return state.cash + state.reserved;
}

export function availableCash(state: Pick<FundState, "cash">): Amount {
  return state.cash;
}

export function parseUnits(value: string | number, decimals = 6): Amount {
  const s = String(value);
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid amount: ${value}`);
  }
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

export function formatUnits(amount: Amount, decimals = 6): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}
