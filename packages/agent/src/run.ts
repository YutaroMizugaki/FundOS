/**
 * Example standalone agent process for a demo fund.
 * Usage: npm run agent:run
 */
import {
  FundVault,
  formatUnits,
  parseUnits,
} from "@fundos/core";
import { AutonomousFundAgent } from "./index.js";

const fund = FundVault.create({
  name: "FundOS Demo Fund",
  baseAsset: "USDC",
  mandate: {
    purpose: "プログラマブルマネーで公共財と気候適応を自律支援する",
    allowedCategories: ["public-goods", "climate", "research"],
    scope: "global",
  },
  reserveFloorRatio: 0.25,
  maxDisbursementRatio: 0.05,
  initialDeposit: parseUnits("1000000"),
});

fund.submitProposal({
  recipient: "ClimateSensorDAO",
  amount: parseUnits("30000"),
  category: "climate",
  rationale: "海岸線センサー網の維持費",
});

fund.submitProposal({
  recipient: "OpenProtoLabs",
  amount: parseUnits("25000"),
  category: "public-goods",
  rationale: "オープンプロトコル実装助成",
});

fund.submitProposal({
  recipient: "AdAgency",
  amount: parseUnits("10000"),
  category: "marketing",
  rationale: "宣伝費（マンデート外・拒否されるべき）",
});

const agent = new AutonomousFundAgent(fund, {
  autoExecute: true,
  log: (m) => console.log(m),
});

console.log("=== FundOS Autonomous Agent ===");
console.log(`Fund: ${fund.config.name}`);
console.log(`NAV:  ${formatUnits(fund.getNav())} ${fund.config.baseAsset}`);
console.log(`Mandate: ${fund.config.mandate.purpose}`);
console.log("");

agent.run({ ticks: 1 });

console.log("");
console.log("=== Result ===");
for (const p of fund.getProposals()) {
  console.log(
    `- [${p.status}] ${p.recipient}: ${formatUnits(p.amount)} ${fund.config.baseAsset} (${p.category})`,
  );
}
console.log(`NAV after: ${formatUnits(fund.getNav())} ${fund.config.baseAsset}`);
console.log(
  `Reserved:  ${formatUnits(fund.getState().reserved)} ${fund.config.baseAsset}`,
);
console.log(`Ledger entries: ${fund.getLedger().list().length}`);
