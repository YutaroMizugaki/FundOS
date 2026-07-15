import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FundVault, parseUnits } from "@fundos/core";
import { AutonomousFundAgent } from "./index.js";

describe("AutonomousFundAgent", () => {
  it("self-drives proposal evaluation and disbursement", () => {
    const fund = FundVault.create({
      name: "Autonomous Public Goods",
      mandate: {
        purpose: "Fund builders",
        allowedCategories: ["builders"],
      },
      reserveFloorRatio: 0.2,
      maxDisbursementRatio: 0.1,
      initialDeposit: parseUnits("500000"),
    });

    fund.submitProposal({
      recipient: "builder-1",
      amount: parseUnits("20000"),
      category: "builders",
      rationale: "Open tooling grant",
    });
    fund.submitProposal({
      recipient: "spam",
      amount: parseUnits("1000"),
      category: "ads",
      rationale: "Out of mandate",
    });

    const agent = new AutonomousFundAgent(fund, { autoExecute: true });
    const [result] = agent.run({ ticks: 1 });

    assert.ok(result.actions.some((a) => a.type === "approve_proposal"));
    assert.ok(result.actions.some((a) => a.type === "execute_proposal"));
    assert.ok(result.actions.some((a) => a.type === "reject_proposal"));

    const proposals = fund.getProposals();
    assert.equal(proposals.find((p) => p.recipient === "builder-1")?.status, "executed");
    assert.equal(proposals.find((p) => p.recipient === "spam")?.status, "rejected");
    assert.ok(fund.getLedger().byKind("agent_tick").length >= 1);
  });
});
