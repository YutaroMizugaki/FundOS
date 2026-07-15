/**
 * FundOS core domain types.
 * Programmable money fund — capital governed by executable policy.
 */

/** Supported asset identifiers (ticker / on-chain symbol). */
export type AssetId = string;

/** ISO-8601 timestamp string. */
export type Timestamp = string;

/** Fund lifecycle status. */
export type FundStatus = "draft" | "active" | "paused" | "closed";

/** Mandate describing why the fund exists. */
export interface FundMandate {
  /** Short purpose statement (human + machine readable). */
  purpose: string;
  /** Allowed recipient categories / tags. */
  allowedCategories: string[];
  /** Geographic or thematic scope. */
  scope?: string;
}

/** Static fund configuration. */
export interface FundConfig {
  id: string;
  name: string;
  /** Base accounting asset (e.g. USDC). */
  baseAsset: AssetId;
  mandate: FundMandate;
  /** Fraction of NAV that must remain as reserve (0–1). */
  reserveFloorRatio: number;
  /** Max fraction of NAV for a single disbursement (0–1). */
  maxDisbursementRatio: number;
  createdAt: Timestamp;
}

/** Live fund balances and status. */
export interface FundState {
  status: FundStatus;
  /** Available balance in base asset units (smallest unit, e.g. micro-USDC = 6 decimals). */
  cash: bigint;
  /** Locked / reserved balance. */
  reserved: bigint;
  /** Cumulative deposits. */
  totalInflows: bigint;
  /** Cumulative disbursements. */
  totalOutflows: bigint;
  updatedAt: Timestamp;
}

/** Net asset value helpers treat cash + reserved as NAV for v0. */
export function nav(state: FundState): bigint {
  return state.cash + state.reserved;
}

export function availableCash(state: FundState): bigint {
  return state.cash;
}

/** Proposal requesting a grant / payment from the fund. */
export interface DisbursementProposal {
  id: string;
  recipient: string;
  amount: bigint;
  category: string;
  rationale: string;
  submittedAt: Timestamp;
  /** Optional metadata for policy evaluation. */
  metadata?: Record<string, string | number | boolean>;
}

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "cancelled";

export interface TrackedProposal extends DisbursementProposal {
  status: ProposalStatus;
  decisionReason?: string;
  decidedAt?: Timestamp;
  executedAt?: Timestamp;
  txRef?: string;
}

/** Ledger entry kinds. */
export type LedgerKind =
  | "deposit"
  | "disbursement"
  | "reserve_lock"
  | "reserve_release"
  | "policy_decision"
  | "status_change"
  | "agent_tick";

export interface LedgerEntry {
  id: string;
  fundId: string;
  kind: LedgerKind;
  amount?: bigint;
  counterparty?: string;
  proposalId?: string;
  note: string;
  at: Timestamp;
  /** Structured payload for audit / replay. */
  payload?: Record<string, unknown>;
}

/** Constraint / schedule / trigger policy definition. */
export type PolicyKind = "constraint" | "schedule" | "trigger";

export interface PolicyRule {
  id: string;
  kind: PolicyKind;
  description: string;
  enabled: boolean;
  /** For schedule policies: interval in milliseconds. */
  intervalMs?: number;
  /** For trigger policies: event name. */
  onEvent?: string;
}

/** Result of evaluating a proposal against policies. */
export interface PolicyDecision {
  approved: boolean;
  reasons: string[];
  checks: PolicyCheckResult[];
  at: Timestamp;
}

export interface PolicyCheckResult {
  ruleId: string;
  passed: boolean;
  message: string;
}

/** Action the autonomous agent may take. */
export type AgentAction =
  | { type: "approve_proposal"; proposalId: string; reason: string }
  | { type: "reject_proposal"; proposalId: string; reason: string }
  | { type: "execute_proposal"; proposalId: string }
  | { type: "rebalance_reserve"; targetReserved: bigint }
  | { type: "pause_fund"; reason: string }
  | { type: "resume_fund"; reason: string }
  | { type: "noop"; reason: string };

export interface AgentTickResult {
  at: Timestamp;
  actions: AgentAction[];
  notes: string[];
}

export interface FundSnapshot {
  config: FundConfig;
  state: FundState;
  proposals: TrackedProposal[];
  policies: PolicyRule[];
  ledger: LedgerEntry[];
}
