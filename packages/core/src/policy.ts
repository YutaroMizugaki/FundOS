import {
  availableCash,
  monthKey,
  nav,
  type Amount,
  type DisbursementProposal,
  type FundConfig,
  type FundState,
  type Timestamp,
} from "./types.js";

export interface PolicyCheck {
  ruleId: string;
  passed: boolean;
  message: string;
}

export interface PolicyDecision {
  approved: boolean;
  checks: PolicyCheck[];
  reason: string;
}

/**
 * Programmable-money policy layer.
 * All disbursements must pass these rules before execution.
 */
export class PolicyEngine {
  constructor(
    private config: FundConfig,
    private state: Pick<
      FundState,
      "status" | "cash" | "reserved" | "monthlySpent"
    >,
  ) {}

  update(
    config: FundConfig,
    state: Pick<FundState, "status" | "cash" | "reserved" | "monthlySpent">,
  ): void {
    this.config = config;
    this.state = state;
  }

  evaluate(proposal: DisbursementProposal, at: Timestamp = new Date().toISOString()): PolicyDecision {
    const checks: PolicyCheck[] = [];
    const fundNav = nav(this.state);
    const cash = availableCash(this.state);

    checks.push({
      ruleId: "fund-active",
      passed: this.state.status === "active",
      message:
        this.state.status === "active"
          ? "基金は稼働中"
          : `基金ステータスが ${this.state.status} のため実行不可`,
    });

    checks.push({
      ruleId: "amount-positive",
      passed: proposal.amount > 0n,
      message:
        proposal.amount > 0n ? "金額は正" : "金額は 0 より大きい必要があります",
    });

    const categoryOk = this.config.mandate.allowedCategories.includes(
      proposal.category,
    );
    checks.push({
      ruleId: "mandate-category",
      passed: categoryOk,
      message: categoryOk
        ? `カテゴリ「${proposal.category}」はマンデート内`
        : `カテゴリ「${proposal.category}」はマンデート外`,
    });

    const maxSingle =
      fundNav === 0n
        ? 0n
        : (fundNav *
            BigInt(Math.floor(this.config.maxDisbursementRatio * 1_000_000))) /
          1_000_000n;
    checks.push({
      ruleId: "max-disbursement-ratio",
      passed: fundNav > 0n && proposal.amount <= maxSingle,
      message:
        fundNav > 0n && proposal.amount <= maxSingle
          ? `単筆上限（NAV の ${this.config.maxDisbursementRatio * 100}%）内`
          : `単筆上限超過（上限 ${maxSingle} / NAV ${fundNav}）`,
    });

    const cashOk = proposal.amount <= cash;
    checks.push({
      ruleId: "sufficient-cash",
      passed: cashOk,
      message: cashOk
        ? "利用可能現金が十分"
        : `現金不足（必要 ${proposal.amount} / 残高 ${cash}）`,
    });

    const afterNav = fundNav - proposal.amount;
    const minReserve =
      fundNav === 0n
        ? 0n
        : (fundNav *
            BigInt(Math.floor(this.config.reserveFloorRatio * 1_000_000))) /
          1_000_000n;
    // After spend, remaining NAV must still cover reserve floor of *pre-spend* NAV
    // (conservative: protect corpus).
    const reserveOk = afterNav >= minReserve;
    checks.push({
      ruleId: "reserve-floor",
      passed: reserveOk,
      message: reserveOk
        ? `準備金フロア（${this.config.reserveFloorRatio * 100}%）を維持`
        : `準備金フロアを下回る（実行後 NAV ${afterNav} < 必要 ${minReserve}）`,
    });

    const key = monthKey(at);
    const spent = this.state.monthlySpent[key] ?? 0n;
    const monthlyCap =
      fundNav === 0n
        ? 0n
        : (fundNav *
            BigInt(Math.floor(this.config.monthlySpendCapRatio * 1_000_000))) /
          1_000_000n;
    const monthlyOk = spent + proposal.amount <= monthlyCap;
    checks.push({
      ruleId: "monthly-spend-cap",
      passed: monthlyOk,
      message: monthlyOk
        ? `月次上限内（消化 ${spent} + ${proposal.amount} / 上限 ${monthlyCap}）`
        : `月次支出上限超過（消化 ${spent} + 申請 ${proposal.amount} > ${monthlyCap}）`,
    });

    const approved = checks.every((c) => c.passed);
    const failed = checks.filter((c) => !c.passed).map((c) => c.ruleId);
    return {
      approved,
      checks,
      reason: approved
        ? "すべてのポリシーを充足"
        : `ポリシー違反: ${failed.join(", ")}`,
    };
  }

  /** Remaining headroom under monthly cap. */
  monthlyHeadroom(at: Timestamp = new Date().toISOString()): Amount {
    const fundNav = nav(this.state);
    const key = monthKey(at);
    const spent = this.state.monthlySpent[key] ?? 0n;
    const monthlyCap =
      fundNav === 0n
        ? 0n
        : (fundNav *
            BigInt(Math.floor(this.config.monthlySpendCapRatio * 1_000_000))) /
          1_000_000n;
    return monthlyCap > spent ? monthlyCap - spent : 0n;
  }
}
