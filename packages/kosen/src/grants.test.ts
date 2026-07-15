import { describe, expect, it } from "vitest";
import { parseUnits } from "@fundos/core";
import {
  createKosenFund,
  KOSEN_REGISTRY,
  listKosen,
  openPitchRound,
  runVoteAndSettle,
  seedDemoArena,
  submitStudentPitch,
} from "./index.js";

describe("@fundos/kosen pitch-vote", () => {
  it("has a non-empty national registry", () => {
    expect(KOSEN_REGISTRY.length).toBeGreaterThan(40);
    expect(listKosen({ region: "関東信越" }).length).toBeGreaterThan(3);
  });

  it("seeds arena and settles by contributor votes", () => {
    const fund = createKosenFund();
    const { contributors, pitches, roundId } = seedDemoArena(fund, {
      region: "東海",
    });
    expect(contributors.length).toBe(3);
    expect(pitches.length).toBeGreaterThanOrEqual(2);

    const [c0, c1, c2] = contributors;
    const [p0, p1, p2] = pitches;
    const result = runVoteAndSettle(fund, roundId, [
      {
        contributorId: c0!.id,
        allocations: [
          { pitchId: p0!.id, weight: parseUnits("200000") },
          { pitchId: p1!.id, weight: parseUnits("100000") },
        ],
      },
      {
        contributorId: c1!.id,
        allocations: [{ pitchId: p1!.id, weight: parseUnits("150000") }],
      },
      {
        contributorId: c2!.id,
        allocations: [
          { pitchId: p2?.id ?? p0!.id, weight: parseUnits("200000") },
        ],
      },
    ]);

    expect(result.round.status).toBe("settled");
    expect(result.executed.length).toBeGreaterThan(0);
    const funded = result.pitches.filter((p) => p.fundedAmount > 0n);
    expect(funded.length).toBeGreaterThan(0);
  });

  it("submitStudentPitch resolves kosen school", () => {
    const fund = createKosenFund();
    fund.contribute({ name: "X", amount: parseUnits("100000") });
    const round = openPitchRound(fund, "R", { budgetRatio: 0.4 });
    const pitch = submitStudentPitch(fund, {
      roundId: round.id,
      studentName: "山田",
      kosenId: "kosen_tokyo",
      title: "テスト",
      abstract: "要旨",
      category: "research",
      requestedAmount: parseUnits("10000"),
    });
    expect(pitch.schoolName).toContain("東京");
  });

  it("rejects unknown kosen id", () => {
    const fund = createKosenFund();
    fund.contribute({ name: "X", amount: parseUnits("100000") });
    openPitchRound(fund, "R", { budgetRatio: 0.4 });
    expect(() =>
      submitStudentPitch(fund, {
        studentName: "Y",
        kosenId: "kosen_unknown",
        title: "x",
        abstract: "y",
        category: "research",
        requestedAmount: parseUnits("1000"),
      }),
    ).toThrow(/Unknown kosen/);
  });
});
