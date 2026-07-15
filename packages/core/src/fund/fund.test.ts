import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FundVault, formatUnits, parseUnits } from "./index.js";

describe("FundVault autonomous fund", () => {
  it("capitalizes, locks reserve, and auto-approves valid grants", () => {
    const fund = FundVault.create({
      name: "Climate Resilience Fund",
      mandate: {
        purpose: "Support climate adaptation projects",
        allowedCategories: ["adaptation", "research"],
      },
      reserveFloorRatio: 0.2,
      maxDisbursementRatio: 0.05,
      initialDeposit: parseUnits("1000000"), // 1,000,000 USDC
    });

    assert.equal(fund.getState().status, "active");
    assert.equal(formatUnits(fund.getNav()), "1000000");
    assert.equal(formatUnits(fund.getState().reserved), "200000");

    const proposal = fund.submitProposal({
      recipient: "0xRecipientAdaptationDao",
      amount: parseUnits("40000"), // 4% of NAV
      category: "adaptation",
      rationale: "Coastal early-warning sensors",
    });

    const approved = fund.approveProposal(proposal.id, "Within policy bounds");
    assert.equal(approved.status, "approved");

    const executed = fund.executeProposal(proposal.id);
    assert.equal(executed.status, "executed");
    assert.equal(formatUnits(fund.getNav()), "960000");
  });

  it("rejects out-of-mandate and over-cap proposals", () => {
    const fund = FundVault.create({
      name: "Public Goods Fund",
      mandate: {
        purpose: "Fund open-source public goods",
        allowedCategories: ["opensource"],
      },
      reserveFloorRatio: 0.2,
      maxDisbursementRatio: 0.05,
      initialDeposit: parseUnits("100000"),
    });

    const badCategory = fund.submitProposal({
      recipient: "alice",
      amount: parseUnits("1000"),
      category: "marketing",
      rationale: "Ads",
    });
    const rejected = fund.approveProposal(badCategory.id, "try");
    assert.equal(rejected.status, "rejected");

    const overCap = fund.submitProposal({
      recipient: "bob",
      amount: parseUnits("10000"), // 10% > 5% cap
      category: "opensource",
      rationale: "Too large",
    });
    const decision = fund.evaluateProposal(overCap.id);
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.some((r) => r.includes("max disbursement")));
  });

  it("preserves reserve floor across disbursements", () => {
    const fund = FundVault.create({
      name: "Safety Fund",
      mandate: {
        purpose: "Emergency support",
        allowedCategories: ["emergency"],
      },
      reserveFloorRatio: 0.5,
      maxDisbursementRatio: 0.4,
      initialDeposit: parseUnits("10000"),
    });

    // Try to take 40% — leaves 60% which is still above 50% floor → OK
    const ok = fund.submitProposal({
      recipient: "helper",
      amount: parseUnits("4000"),
      category: "emergency",
      rationale: "Relief",
    });
    assert.equal(fund.evaluateProposal(ok.id).approved, true);

    // After executing 4000, NAV=6000, floor=50% → max leave 3000, so another 4000 would breach
    fund.approveProposal(ok.id, "ok");
    fund.executeProposal(ok.id);

    const breach = fund.submitProposal({
      recipient: "helper2",
      amount: parseUnits("3500"),
      category: "emergency",
      rationale: "Would breach floor",
    });
    assert.equal(fund.evaluateProposal(breach.id).approved, false);
  });
});
