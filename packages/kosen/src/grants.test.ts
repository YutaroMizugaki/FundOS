import { describe, expect, it } from "vitest";
import { parseUnits } from "@fundos/core";
import {
  createKosenFund,
  KOSEN_REGISTRY,
  listKosen,
  runEqualShareCycle,
  runRoundRobinGrant,
  submitKosenGrant,
} from "./index.js";

describe("@fundos/kosen", () => {
  it("has a non-empty national registry", () => {
    expect(KOSEN_REGISTRY.length).toBeGreaterThan(40);
    expect(listKosen({ region: "関東信越" }).length).toBeGreaterThan(3);
  });

  it("creates kosen fund and executes a grant", () => {
    const fund = createKosenFund({
      initialDeposit: parseUnits("2000000"),
    });
    const p = submitKosenGrant(fund, {
      kosenId: "kosen_tokyo",
      amount: parseUnits("20000"),
      category: "competition",
      rationale: "高専ロボコン出場支援",
    });
    const { proposal } = fund.autoProcess(p.id);
    expect(proposal.status).toBe("executed");
  });

  it("runs equal-share monthly cycle across a subset", () => {
    const fund = createKosenFund({
      initialDeposit: parseUnits("5000000"),
      monthlySpendCapRatio: 0.1,
      maxDisbursementRatio: 0.05,
    });
    const schools = listKosen({ region: "東海" });
    const result = runEqualShareCycle(fund, {
      schools,
      category: "equipment",
      perSchoolCap: "50000",
    });
    expect(result.submitted.length).toBe(schools.length);
    expect(result.executed.length).toBe(schools.length);
    expect(result.rejected.length).toBe(0);
  });

  it("round-robin advances cursor", () => {
    const fund = createKosenFund({
      initialDeposit: parseUnits("3000000"),
    });
    const schools = listKosen({ region: "四国" });
    const a = runRoundRobinGrant(fund, 0, {
      amount: parseUnits("15000"),
      schools,
    });
    const b = runRoundRobinGrant(fund, a.nextCursor, {
      amount: parseUnits("15000"),
      schools,
    });
    expect(a.proposal?.recipientId).not.toBe(b.proposal?.recipientId);
    expect(a.proposal?.status).toBe("executed");
    expect(b.proposal?.status).toBe("executed");
  });

  it("rejects unknown kosen id", () => {
    const fund = createKosenFund({ initialDeposit: parseUnits("1000000") });
    expect(() =>
      submitKosenGrant(fund, {
        kosenId: "kosen_unknown",
        amount: parseUnits("1000"),
        category: "research",
        rationale: "x",
      }),
    ).toThrow(/Unknown kosen/);
  });
});
