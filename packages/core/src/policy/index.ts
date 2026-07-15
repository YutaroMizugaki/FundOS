import {
  availableCash,
  nav,
  type DisbursementProposal,
  type FundConfig,
  type FundState,
  type PolicyCheckResult,
  type PolicyDecision,
  type PolicyRule,
  type Timestamp,
} from "../types/index.js";

function now(): Timestamp {
  return new Date().toISOString();
}

export interface PolicyEngineContext {
  config: FundConfig;
  state: FundState;
  policies: PolicyRule[];
}

/**
 * On-ruleset policy engine.
 * Evaluates disbursement proposals against fund mandate and capital constraints.
 * This is the "programmable" layer of programmable money.
 */
export class PolicyEngine {
  constructor(private readonly ctx: PolicyEngineContext) {}

  updateContext(partial: Partial<PolicyEngineContext>): void {
    Object.assign(this.ctx, partial);
  }

  getPolicies(): readonly PolicyRule[] {
    return this.ctx.policies;
  }

  evaluateProposal(proposal: DisbursementProposal): PolicyDecision {
    const checks: PolicyCheckResult[] = [];
    const { config, state } = this.ctx;
    const fundNav = nav(state);
    const cash = availableCash(state);

    // Fund must be active
    checks.push({
      ruleId: "fund-active",
      passed: state.status === "active",
      message:
        state.status === "active"
          ? "Fund is active"
          : `Fund status is ${state.status}, not active`,
    });

    // Positive amount
    checks.push({
      ruleId: "amount-positive",
      passed: proposal.amount > 0n,
      message:
        proposal.amount > 0n
          ? "Amount is positive"
          : "Amount must be greater than zero",
    });

    // Mandate category
    const categoryOk = config.mandate.allowedCategories.includes(
      proposal.category,
    );
    checks.push({
      ruleId: "mandate-category",
      passed: categoryOk,
      message: categoryOk
        ? `Category "${proposal.category}" is within mandate`
        : `Category "${proposal.category}" is outside mandate [${config.mandate.allowedCategories.join(", ")}]`,
    });

    // Max single disbursement vs NAV
    const maxDisburse =
      (fundNav * BigInt(Math.floor(config.maxDisbursementRatio * 1_000_000))) /
      1_000_000n;
    const withinCap = fundNav === 0n ? false : proposal.amount <= maxDisburse;
    checks.push({
      ruleId: "max-disbursement-ratio",
      passed: withinCap,
      message: withinCap
        ? `Amount within max ${config.maxDisbursementRatio * 100}% of NAV`
        : `Amount ${proposal.amount} exceeds max disbursement ${maxDisburse} (${config.maxDisbursementRatio * 100}% of NAV ${fundNav})`,
    });

    // Reserve floor: after disbursement, remaining cash+reserved must keep reserve floor
    // We require: (nav - amount) >= nav * reserveFloor  OR equivalently amount <= nav * (1 - floor)
    // Also cash must cover the payment.
    const cashOk = proposal.amount <= cash;
    checks.push({
      ruleId: "sufficient-cash",
      passed: cashOk,
      message: cashOk
        ? "Sufficient available cash"
        : `Insufficient cash: need ${proposal.amount}, have ${cash}`,
    });

    const minNavAfter =
      (fundNav * BigInt(Math.floor(config.reserveFloorRatio * 1_000_000))) /
      1_000_000n;
    const navAfter = fundNav - proposal.amount;
    const reserveOk = fundNav === 0n ? false : navAfter >= minNavAfter;
    checks.push({
      ruleId: "reserve-floor",
      passed: reserveOk,
      message: reserveOk
        ? `Reserve floor ${config.reserveFloorRatio * 100}% preserved after disbursement`
        : `Would breach reserve floor: NAV after ${navAfter} < required ${minNavAfter}`,
    });

    // Enabled custom constraint policies (descriptive pass-through for audit)
    for (const rule of this.ctx.policies.filter(
      (p) => p.enabled && p.kind === "constraint",
    )) {
      checks.push({
        ruleId: rule.id,
        passed: true,
        message: `Constraint acknowledged: ${rule.description}`,
      });
    }

    const approved = checks.every((c) => c.passed);
    const reasons = checks.filter((c) => !c.passed).map((c) => c.message);

    return {
      approved,
      reasons: approved ? ["All policy checks passed"] : reasons,
      checks,
      at: now(),
    };
  }

  /** Target reserved balance based on reserve floor policy. */
  targetReserved(): bigint {
    const fundNav = nav(this.ctx.state);
    return (
      (fundNav *
        BigInt(Math.floor(this.ctx.config.reserveFloorRatio * 1_000_000))) /
      1_000_000n
    );
  }
}

/** Default policy pack for a new autonomous fund. */
export function defaultPolicies(): PolicyRule[] {
  return [
    {
      id: "reserve-floor-constraint",
      kind: "constraint",
      description: "Maintain configured reserve floor of NAV at all times",
      enabled: true,
    },
    {
      id: "max-grant-constraint",
      kind: "constraint",
      description: "Single grant cannot exceed max disbursement ratio of NAV",
      enabled: true,
    },
    {
      id: "autonomous-evaluation-tick",
      kind: "schedule",
      description: "Periodically evaluate pending proposals and rebalance reserve",
      enabled: true,
      intervalMs: 5_000,
    },
  ];
}
