import {
  formatUnits,
  parseUnits,
  type FundVault,
  type SettleResult,
} from "@fundos/core";
import {
  createKosenFund,
  openPitchRound,
  runVoteAndSettle,
  seedDemoArena,
  submitStudentPitch,
  type KosenGrantCategory,
} from "@fundos/kosen";

export type AgentPhase =
  | "idle"
  | "seeded"
  | "voting"
  | "settled";

/**
 * Orchestrates a pitch-vote round for demos.
 * Does not invent votes — applies explicit ballots or a simple preference heuristic.
 */
export class PitchVoteAgent {
  phase: AgentPhase = "idle";
  lastResult: SettleResult | null = null;
  roundId: string | null = null;

  constructor(readonly fund: FundVault) {}

  static bootstrap(): PitchVoteAgent {
    return new PitchVoteAgent(createKosenFund());
  }

  /** Seed contributors + student pitches (demo). */
  seedDemo(roundTitle = "高専ピッチデー"): {
    roundId: string;
    pitchCount: number;
    contributorCount: number;
  } {
    const { contributors, pitches, roundId } = seedDemoArena(this.fund, {
      roundTitle,
      region: "東海",
    });
    this.roundId = roundId;
    this.phase = "seeded";
    return {
      roundId,
      pitchCount: pitches.length,
      contributorCount: contributors.length,
    };
  }

  /**
   * Auto-ballot: each contributor puts all votes on the pitch whose
   * requested amount is closest to a preference (demo heuristic only).
   */
  settleWithHeuristic(): SettleResult {
    if (!this.roundId) throw new Error("No round — call seedDemo first");
    const state = this.fund.getState();
    const pitches = state.pitches.filter((p) => p.roundId === this.roundId);
    if (pitches.length === 0) throw new Error("No pitches");

    this.fund.openVoting(this.roundId);
    this.phase = "voting";

    for (const c of state.contributors) {
      // Prefer competition / research alternately by contributor index
      const prefer: KosenGrantCategory =
        c.name.includes("企業") ? "competition" : "research";
      const ranked = [...pitches].sort((a, b) => {
        const as = a.category === prefer ? 0 : 1;
        const bs = b.category === prefer ? 0 : 1;
        return as - bs;
      });
      const top = ranked[0]!;
      const second = ranked[1];
      const allocations =
        second && c.votingPower > parseUnits("50000")
          ? [
              {
                pitchId: top.id,
                weight: (c.votingPower * 2n) / 3n,
              },
              {
                pitchId: second.id,
                weight: c.votingPower - (c.votingPower * 2n) / 3n,
              },
            ]
          : [{ pitchId: top.id, weight: c.votingPower }];
      this.fund.castVote(this.roundId, c.id, allocations);
    }

    this.lastResult = this.fund.settle(this.roundId);
    this.phase = "settled";
    return this.lastResult;
  }

  settleWithBallots(
    ballots: Parameters<typeof runVoteAndSettle>[2],
  ): SettleResult {
    if (!this.roundId) throw new Error("No round");
    this.lastResult = runVoteAndSettle(this.fund, this.roundId, ballots);
    this.phase = "settled";
    return this.lastResult;
  }

  report(): string {
    const s = this.fund.summary();
    const lines = [
      "=== FundOS Pitch-Vote Report ===",
      `基金: ${s.name} [${s.status}]`,
      `NAV: ${s.nav} / 現金 ${s.cash} / 準備金 ${s.reserved}`,
      `拠出者: ${s.contributors}（投票権合計 ${s.totalVotingPower}）`,
      `ピッチ: ${s.pitches} / ラウンド: ${s.rounds}`,
      `フェーズ: ${this.phase}`,
    ];
    if (this.lastResult) {
      for (const p of this.lastResult.pitches) {
        lines.push(
          `- ${p.studentName}「${p.title}」票 ${formatUnits(p.votesReceived)} → 配分 ${formatUnits(p.fundedAmount)} [${p.status}]`,
        );
      }
    }
    return lines.join("\n");
  }
}

export { openPitchRound, submitStudentPitch, createKosenFund };
