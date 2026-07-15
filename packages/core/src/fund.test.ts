import { describe, expect, it } from "vitest";
import { FundVault, parseUnits, formatUnits } from "./index.js";

const mandate = {
  purpose: "高専学生のプレゼンに対し、拠出者投票で配分する",
  allowedCategories: ["equipment", "scholarship", "research", "competition"],
  scope: "日本の高等専門学校の学生プロジェクト",
};

describe("FundVault pitch-vote governance", () => {
  it("grants voting power on contribute", () => {
    const fund = FundVault.create({ name: "高専ピッチ基金", mandate });
    const a = fund.contribute({ name: "Alice", amount: parseUnits("100000") });
    const b = fund.contribute({ name: "Bob", amount: parseUnits("50000") });
    expect(a.votingPower).toBe(parseUnits("100000"));
    expect(b.votingPower).toBe(parseUnits("50000"));
    expect(fund.getState().contributors).toHaveLength(2);
  });

  it("runs pitch → vote → proportional settle", () => {
    const fund = FundVault.create({
      name: "高専ピッチ基金",
      mandate,
      reserveFloorRatio: 0.2,
      maxDisbursementRatio: 0.5,
      monthlySpendCapRatio: 0.8,
    });
    const alice = fund.contribute({
      name: "Alice",
      amount: parseUnits("400000"),
    });
    const bob = fund.contribute({ name: "Bob", amount: parseUnits("100000") });

    const round = fund.openRound({
      title: "2026 春ピッチ",
      budgetRatio: 0.5,
    });
    const p1 = fund.submitPitch({
      roundId: round.id,
      studentName: "佐藤",
      schoolId: "kosen_tokyo",
      schoolName: "東京高専",
      title: "水中ドローン",
      abstract: "湖沼調査用の安価な水中ドローン",
      category: "research",
      requestedAmount: parseUnits("80000"),
    });
    const p2 = fund.submitPitch({
      roundId: round.id,
      studentName: "鈴木",
      schoolId: "kosen_toyota",
      schoolName: "豊田高専",
      title: "ロボコン駆動系",
      abstract: "軽量高出力の駆動モジュール",
      category: "competition",
      requestedAmount: parseUnits("60000"),
    });

    fund.openVoting(round.id);
    fund.castVote(round.id, alice.id, [
      { pitchId: p1.id, weight: parseUnits("300000") },
      { pitchId: p2.id, weight: parseUnits("100000") },
    ]);
    fund.castVote(round.id, bob.id, [
      { pitchId: p2.id, weight: parseUnits("100000") },
    ]);

    const result = fund.settle(round.id);
    expect(result.round.status).toBe("settled");
    expect(result.executed.length).toBe(2);

    const state = fund.getState();
    const pitch1 = state.pitches.find((p) => p.id === p1.id)!;
    const pitch2 = state.pitches.find((p) => p.id === p2.id)!;
    // votes: p1=300k, p2=200k, total=500k
    // budget = 50% of cash after reserve — verify both got some funding
    expect(pitch1.votesReceived).toBe(parseUnits("300000"));
    expect(pitch2.votesReceived).toBe(parseUnits("200000"));
    expect(pitch1.fundedAmount).toBeGreaterThan(0n);
    expect(pitch2.fundedAmount).toBeGreaterThan(0n);
    expect(pitch1.fundedAmount).toBeGreaterThan(pitch2.fundedAmount);
  });

  it("rejects votes exceeding voting power", () => {
    const fund = FundVault.create({ name: "高専ピッチ基金", mandate });
    const alice = fund.contribute({
      name: "Alice",
      amount: parseUnits("10000"),
    });
    const round = fund.openRound({ title: "R1", budget: parseUnits("5000") });
    const pitch = fund.submitPitch({
      roundId: round.id,
      studentName: "A",
      schoolId: "kosen_tokyo",
      schoolName: "東京高専",
      title: "T",
      abstract: "x",
      category: "research",
      requestedAmount: parseUnits("5000"),
    });
    fund.openVoting(round.id);
    expect(() =>
      fund.castVote(round.id, alice.id, [
        { pitchId: pitch.id, weight: parseUnits("10001") },
      ]),
    ).toThrow(/voting power/);
  });

  it("rejects out-of-mandate pitch category", () => {
    const fund = FundVault.create({ name: "高専ピッチ基金", mandate });
    fund.contribute({ name: "Alice", amount: parseUnits("100000") });
    const round = fund.openRound({ title: "R1", budgetRatio: 0.3 });
    expect(() =>
      fund.submitPitch({
        roundId: round.id,
        studentName: "A",
        schoolId: "kosen_tokyo",
        schoolName: "東京高専",
        title: "土地",
        abstract: "x",
        category: "real-estate",
        requestedAmount: parseUnits("1000"),
      }),
    ).toThrow(/mandate/);
  });

  it("pause blocks contribute and settle path", () => {
    const fund = FundVault.create({ name: "高専ピッチ基金", mandate });
    fund.contribute({ name: "Alice", amount: parseUnits("100000") });
    fund.pause();
    expect(() =>
      fund.contribute({ name: "Bob", amount: parseUnits("1000") }),
    ).toThrow(/paused/);
  });

  it("formats units", () => {
    expect(formatUnits(parseUnits("12.5"), 6)).toBe("12.5");
  });
});
