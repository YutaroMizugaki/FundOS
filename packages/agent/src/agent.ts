import {
  parseUnits,
  type DisbursementProposal,
  type FundVault,
} from "@fundos/core";
import {
  listKosen,
  runEqualShareCycle,
  runRoundRobinGrant,
  submitKosenGrant,
  type KosenGrantCategory,
  type KosenRegion,
} from "@fundos/kosen";

export type AgentMode = "equal-share" | "round-robin" | "drain-pending";

export interface AgentTickResult {
  mode: AgentMode;
  at: string;
  executed: DisbursementProposal[];
  rejected: DisbursementProposal[];
  notes: string[];
}

export interface AutonomousKosenAgentOptions {
  mode?: AgentMode;
  region?: KosenRegion;
  category?: KosenGrantCategory;
  /** Round-robin amount in major units. */
  roundRobinAmount?: string;
  perSchoolCap?: string;
}

/**
 * Policy-bounded autonomous loop for the KOSEN grant fund.
 * Spending is always gated by FundVault policy + KOSEN mandate.
 */
export class AutonomousKosenAgent {
  private cursor = 0;
  private readonly mode: AgentMode;
  private readonly region?: KosenRegion;
  private readonly category: KosenGrantCategory;
  private readonly roundRobinAmount: string;
  private readonly perSchoolCap: string;
  readonly history: AgentTickResult[] = [];

  constructor(
    private readonly fund: FundVault,
    options: AutonomousKosenAgentOptions = {},
  ) {
    this.mode = options.mode ?? "equal-share";
    this.region = options.region;
    this.category = options.category ?? "equipment";
    this.roundRobinAmount = options.roundRobinAmount ?? "20000";
    this.perSchoolCap = options.perSchoolCap ?? "40000";
  }

  getCursor(): number {
    return this.cursor;
  }

  tick(): AgentTickResult {
    const at = new Date().toISOString();
    const notes: string[] = [];
    let executed: DisbursementProposal[] = [];
    let rejected: DisbursementProposal[] = [];

    const schools = this.region
      ? listKosen({ region: this.region })
      : listKosen();

    if (this.fund.getState().status !== "active") {
      notes.push("基金が停止中のためスキップ");
      const result: AgentTickResult = {
        mode: this.mode,
        at,
        executed,
        rejected,
        notes,
      };
      this.history.push(result);
      return result;
    }

    switch (this.mode) {
      case "equal-share": {
        const cycle = runEqualShareCycle(this.fund, {
          schools,
          category: this.category,
          perSchoolCap: this.perSchoolCap,
        });
        executed = cycle.executed;
        rejected = cycle.rejected;
        notes.push(
          `均等拠出: ${schools.length} 校対象 / 実行 ${executed.length} / 却下 ${rejected.length}`,
        );
        break;
      }
      case "round-robin": {
        const { nextCursor, proposal } = runRoundRobinGrant(
          this.fund,
          this.cursor,
          {
            amount: parseUnits(this.roundRobinAmount),
            category: this.category,
            schools,
          },
        );
        this.cursor = nextCursor;
        if (proposal?.status === "executed") executed = [proposal];
        else if (proposal) rejected = [proposal];
        notes.push(
          `ラウンドロビン cursor→${this.cursor}: ${proposal?.recipientName ?? "なし"} (${proposal?.status ?? "n/a"})`,
        );
        break;
      }
      case "drain-pending": {
        for (const p of this.fund.pendingProposals()) {
          const { proposal } = this.fund.autoProcess(p.id);
          if (proposal.status === "executed") executed.push(proposal);
          else rejected.push(proposal);
        }
        notes.push(
          `保留案件処理: 実行 ${executed.length} / 却下 ${rejected.length}`,
        );
        break;
      }
    }

    const result: AgentTickResult = {
      mode: this.mode,
      at,
      executed,
      rejected,
      notes,
    };
    this.history.push(result);
    return result;
  }

  run(ticks = 1): AgentTickResult[] {
    const out: AgentTickResult[] = [];
    for (let i = 0; i < ticks; i++) out.push(this.tick());
    return out;
  }

  /** Seed demo proposals without executing (for drain-pending demos). */
  seedDemoProposals(count = 3): DisbursementProposal[] {
    const schools = this.region
      ? listKosen({ region: this.region })
      : listKosen();
    const seeded: DisbursementProposal[] = [];
    for (let i = 0; i < Math.min(count, schools.length); i++) {
      const school = schools[i]!;
      seeded.push(
        submitKosenGrant(this.fund, {
          kosenId: school.id,
          amount: parseUnits("12000"),
          category: "research",
          rationale: `${school.shortName} 研究萌芽支援（デモ申請）`,
        }),
      );
    }
    return seeded;
  }

  report(): string {
    const s = this.fund.summary();
    const lines = [
      `=== FundOS Agent Report ===`,
      `基金: ${s.name} [${s.status}]`,
      `NAV: ${s.nav} / 現金 ${s.cash} / 準備金 ${s.reserved}`,
      `提案: ${s.proposals}（保留 ${s.pending} / 実行済 ${s.executed}）`,
      `モード: ${this.mode}`,
      `ticks: ${this.history.length}`,
    ];
    for (const h of this.history.slice(-5)) {
      lines.push(
        `- ${h.at}: 実行${h.executed.length} 却下${h.rejected.length} — ${h.notes.join("; ")}`,
      );
    }
    return lines.join("\n");
  }
}
