import { describe, expect, it } from "vitest";
import { FundVault, parseUnits, formatUnits } from "./index.js";

describe("FundVault", () => {
  const mandate = {
    purpose: "高専への教育・研究支援",
    allowedCategories: ["equipment", "scholarship", "research"],
    scope: "日本の高等専門学校",
  };

  it("creates fund with reserve lock", () => {
    const fund = FundVault.create({
      name: "高専基金",
      mandate,
      initialDeposit: parseUnits("1000000"),
      reserveFloorRatio: 0.2,
    });
    const s = fund.getState();
    expect(s.reserved).toBe(parseUnits("200000"));
    expect(s.cash).toBe(parseUnits("800000"));
    expect(s.status).toBe("active");
  });

  it("approves in-mandate kosen grant and executes", () => {
    const fund = FundVault.create({
      name: "高専基金",
      mandate,
      initialDeposit: parseUnits("1000000"),
      maxDisbursementRatio: 0.05,
      monthlySpendCapRatio: 0.1,
    });
    const p = fund.submitProposal({
      recipientId: "kosen_tokyo",
      recipientName: "東京工業高等専門学校",
      amount: parseUnits("30000"),
      category: "equipment",
      rationale: "ロボコン用部品",
    });
    const { decision, proposal } = fund.autoProcess(p.id);
    expect(decision.approved).toBe(true);
    expect(proposal.status).toBe("executed");
    expect(fund.getState().cash).toBe(parseUnits("770000"));
  });

  it("rejects out-of-mandate category", () => {
    const fund = FundVault.create({
      name: "高専基金",
      mandate,
      initialDeposit: parseUnits("1000000"),
    });
    const p = fund.submitProposal({
      recipientId: "kosen_tokyo",
      recipientName: "東京工業高等専門学校",
      amount: parseUnits("10000"),
      category: "real-estate",
      rationale: "土地購入",
    });
    const { decision, proposal } = fund.autoProcess(p.id);
    expect(decision.approved).toBe(false);
    expect(proposal.status).toBe("rejected");
  });

  it("rejects when monthly cap exceeded", () => {
    const fund = FundVault.create({
      name: "高専基金",
      mandate,
      initialDeposit: parseUnits("1000000"),
      maxDisbursementRatio: 0.1,
      monthlySpendCapRatio: 0.05,
    });
    const a = fund.submitProposal({
      recipientId: "kosen_a",
      recipientName: "A高専",
      amount: parseUnits("40000"),
      category: "scholarship",
      rationale: "奨学金",
    });
    fund.autoProcess(a.id);
    const b = fund.submitProposal({
      recipientId: "kosen_b",
      recipientName: "B高専",
      amount: parseUnits("20000"),
      category: "scholarship",
      rationale: "奨学金",
    });
    const { decision } = fund.autoProcess(b.id);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("monthly-spend-cap");
  });

  it("pause blocks disbursement", () => {
    const fund = FundVault.create({
      name: "高専基金",
      mandate,
      initialDeposit: parseUnits("1000000"),
    });
    fund.pause();
    const p = fund.submitProposal({
      recipientId: "kosen_tokyo",
      recipientName: "東京工業高等専門学校",
      amount: parseUnits("10000"),
      category: "research",
      rationale: "研究費",
    });
    const { decision } = fund.autoProcess(p.id);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("fund-active");
  });

  it("formats units", () => {
    expect(formatUnits(parseUnits("12.5"), 6)).toBe("12.5");
  });
});
