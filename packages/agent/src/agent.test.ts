import { describe, expect, it } from "vitest";
import { parseUnits } from "@fundos/core";
import { createKosenFund } from "@fundos/kosen";
import { AutonomousKosenAgent } from "./agent.js";

describe("AutonomousKosenAgent", () => {
  it("runs equal-share tick for a region", () => {
    const fund = createKosenFund({
      initialDeposit: parseUnits("4000000"),
      monthlySpendCapRatio: 0.1,
    });
    const agent = new AutonomousKosenAgent(fund, {
      mode: "equal-share",
      region: "北陸",
      category: "equipment",
      perSchoolCap: "25000",
    });
    const result = agent.tick();
    expect(result.executed.length).toBeGreaterThan(0);
    expect(result.rejected.length).toBe(0);
  });

  it("skips when paused", () => {
    const fund = createKosenFund({ initialDeposit: parseUnits("2000000") });
    fund.pause();
    const agent = new AutonomousKosenAgent(fund, {
      mode: "round-robin",
      region: "近畿",
    });
    const result = agent.tick();
    expect(result.executed.length).toBe(0);
    expect(result.notes[0]).toMatch(/停止/);
  });

  it("drains seeded pending proposals", () => {
    const fund = createKosenFund({ initialDeposit: parseUnits("3000000") });
    const agent = new AutonomousKosenAgent(fund, {
      mode: "drain-pending",
      region: "四国",
    });
    agent.seedDemoProposals(2);
    expect(fund.pendingProposals().length).toBe(2);
    const result = agent.tick();
    expect(result.executed.length).toBe(2);
    expect(fund.pendingProposals().length).toBe(0);
  });
});
