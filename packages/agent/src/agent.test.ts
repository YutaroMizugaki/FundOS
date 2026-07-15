import { describe, expect, it } from "vitest";
import { parseUnits } from "@fundos/core";
import { PitchVoteAgent } from "./agent.js";

describe("PitchVoteAgent", () => {
  it("seeds and settles a pitch round", () => {
    const agent = PitchVoteAgent.bootstrap();
    const seeded = agent.seedDemo();
    expect(seeded.pitchCount).toBeGreaterThan(0);
    const result = agent.settleWithHeuristic();
    expect(result.round.status).toBe("settled");
    expect(result.executed.length).toBeGreaterThan(0);
    expect(agent.phase).toBe("settled");
  });

  it("report includes funded pitches", () => {
    const agent = PitchVoteAgent.bootstrap();
    agent.seedDemo();
    agent.settleWithHeuristic();
    expect(agent.report()).toMatch(/配分/);
  });

  it("explicit ballots work", () => {
    const agent = PitchVoteAgent.bootstrap();
    const { roundId } = agent.seedDemo();
    const state = agent.fund.getState();
    const c = state.contributors[0]!;
    const p = state.pitches[0]!;
    const result = agent.settleWithBallots([
      {
        contributorId: c.id,
        allocations: [{ pitchId: p.id, weight: c.votingPower }],
      },
      ...state.contributors.slice(1).map((ctrb) => ({
        contributorId: ctrb.id,
        allocations: [
          {
            pitchId: state.pitches[1]?.id ?? p.id,
            weight: ctrb.votingPower,
          },
        ],
      })),
    ]);
    expect(result.round.id).toBe(roundId);
    expect(parseUnits("1") > 0n).toBe(true);
  });
});
