import {
  FundVault,
  parseUnits,
  type Amount,
  type DisbursementProposal,
  type Mandate,
} from "@fundos/core";
import { getKosen, KOSEN_REGISTRY, type KosenSchool } from "./registry.js";

/** Grant categories allowed for the KOSEN fund MVP. */
export const KOSEN_GRANT_CATEGORIES = [
  "equipment",
  "scholarship",
  "research",
  "competition",
] as const;

export type KosenGrantCategory = (typeof KOSEN_GRANT_CATEGORIES)[number];

export const KOSEN_MANDATE: Mandate = {
  purpose:
    "日本の高等専門学校（高専）における実験設備・奨学金・研究・競技活動を継続支援する",
  allowedCategories: [...KOSEN_GRANT_CATEGORIES],
  scope: "日本の高等専門学校",
};

export interface KosenFundOptions {
  name?: string;
  initialDeposit: Amount;
  reserveFloorRatio?: number;
  maxDisbursementRatio?: number;
  monthlySpendCapRatio?: number;
}

export interface GrantRequest {
  kosenId: string;
  amount: Amount;
  category: KosenGrantCategory;
  rationale: string;
}

export interface CycleResult {
  submitted: DisbursementProposal[];
  executed: DisbursementProposal[];
  rejected: DisbursementProposal[];
}

/**
 * Create a FundOS vault preconfigured for KOSEN grants.
 */
export function createKosenFund(options: KosenFundOptions): FundVault {
  return FundVault.create({
    name: options.name ?? "FundOS 高専拠出基金",
    mandate: KOSEN_MANDATE,
    initialDeposit: options.initialDeposit,
    reserveFloorRatio: options.reserveFloorRatio ?? 0.25,
    maxDisbursementRatio: options.maxDisbursementRatio ?? 0.04,
    monthlySpendCapRatio: options.monthlySpendCapRatio ?? 0.08,
  });
}

export function submitKosenGrant(
  fund: FundVault,
  request: GrantRequest,
): DisbursementProposal {
  const school = getKosen(request.kosenId);
  if (!school) {
    throw new Error(`Unknown kosen id: ${request.kosenId}`);
  }
  if (!KOSEN_GRANT_CATEGORIES.includes(request.category)) {
    throw new Error(`Invalid category: ${request.category}`);
  }
  return fund.submitProposal({
    recipientId: school.id,
    recipientName: school.name,
    amount: request.amount,
    category: request.category,
    rationale: request.rationale,
  });
}

/**
 * Equal-share monthly cycle: split available monthly headroom across
 * selected schools (or all national kosen), submit + auto-process.
 */
export function runEqualShareCycle(
  fund: FundVault,
  opts: {
    schools?: KosenSchool[];
    category?: KosenGrantCategory;
    rationale?: string;
    /** Cap per school in major units (string). */
    perSchoolCap?: string;
  } = {},
): CycleResult {
  const schools = opts.schools ?? [...KOSEN_REGISTRY];
  if (schools.length === 0) {
    return { submitted: [], executed: [], rejected: [] };
  }

  const state = fund.getState();
  const nav = state.cash + state.reserved;
  const monthlyCap =
    (nav *
      BigInt(Math.floor(state.config.monthlySpendCapRatio * 1_000_000))) /
    1_000_000n;
  const key = new Date().toISOString().slice(0, 7);
  const spent = state.monthlySpent[key] ?? 0n;
  const headroom = monthlyCap > spent ? monthlyCap - spent : 0n;
  if (headroom <= 0n) {
    return { submitted: [], executed: [], rejected: [] };
  }

  const perSchoolCap = opts.perSchoolCap
    ? parseUnits(opts.perSchoolCap)
    : headroom;
  const equal = headroom / BigInt(schools.length);
  const amount = equal < perSchoolCap ? equal : perSchoolCap;
  if (amount <= 0n) {
    return { submitted: [], executed: [], rejected: [] };
  }

  const category = opts.category ?? "equipment";
  const rationale =
    opts.rationale ??
    `月次均等拠出サイクル（${category}）— FundOS 自立駆動`;

  const submitted: DisbursementProposal[] = [];
  const executed: DisbursementProposal[] = [];
  const rejected: DisbursementProposal[] = [];

  for (const school of schools) {
    const proposal = submitKosenGrant(fund, {
      kosenId: school.id,
      amount,
      category,
      rationale: `${school.shortName}: ${rationale}`,
    });
    submitted.push(proposal);
    const { proposal: decided } = fund.autoProcess(proposal.id);
    if (decided.status === "executed") executed.push(decided);
    else rejected.push(decided);
  }

  return { submitted, executed, rejected };
}

/** Round-robin: fund one school per tick from a rotating cursor. */
export function runRoundRobinGrant(
  fund: FundVault,
  cursor: number,
  opts: {
    amount: Amount;
    category?: KosenGrantCategory;
    rationale?: string;
    schools?: KosenSchool[];
  },
): { nextCursor: number; proposal: DisbursementProposal | null } {
  const schools = opts.schools ?? [...KOSEN_REGISTRY];
  if (schools.length === 0) return { nextCursor: 0, proposal: null };
  const index = ((cursor % schools.length) + schools.length) % schools.length;
  const school = schools[index]!;
  const proposal = submitKosenGrant(fund, {
    kosenId: school.id,
    amount: opts.amount,
    category: opts.category ?? "scholarship",
    rationale:
      opts.rationale ??
      `${school.shortName}へのラウンドロビン拠出（自立駆動）`,
  });
  const { proposal: decided } = fund.autoProcess(proposal.id);
  return { nextCursor: index + 1, proposal: decided };
}
