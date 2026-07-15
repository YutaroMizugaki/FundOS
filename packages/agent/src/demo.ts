#!/usr/bin/env node
import { formatUnits, parseUnits } from "@fundos/core";
import {
  createKosenFund,
  listKosen,
  submitKosenGrant,
} from "@fundos/kosen";
import { AutonomousKosenAgent } from "./agent.js";

function main(): void {
  console.log("FundOS — 高専拠出 自立駆動デモ\n");

  const fund = createKosenFund({
    initialDeposit: parseUnits("5000000"),
    reserveFloorRatio: 0.25,
    maxDisbursementRatio: 0.04,
    monthlySpendCapRatio: 0.08,
  });

  console.log("① 基金組成");
  console.log(fund.summary());
  console.log("");

  console.log("② 個別助成（東京高専・ロボコン）");
  const one = submitKosenGrant(fund, {
    kosenId: "kosen_tokyo",
    amount: parseUnits("25000"),
    category: "competition",
    rationale: "高専ロボコン出場機材",
  });
  const processed = fund.autoProcess(one.id);
  console.log(
    `  → ${processed.proposal.status}: ${processed.decision.reason}`,
  );
  console.log("");

  console.log("③ マンデート外は自動却下");
  const bad = fund.submitProposal({
    recipientId: "corp_x",
    recipientName: "無関係な法人",
    amount: parseUnits("10000"),
    category: "real-estate",
    rationale: "土地購入",
  });
  const badResult = fund.autoProcess(bad.id);
  console.log(`  → ${badResult.proposal.status}: ${badResult.decision.reason}`);
  console.log("");

  console.log("④ エージェント: 東海エリア均等拠出");
  const agent = new AutonomousKosenAgent(fund, {
    mode: "equal-share",
    region: "東海",
    category: "equipment",
    perSchoolCap: "30000",
  });
  const tick = agent.tick();
  for (const e of tick.executed) {
    console.log(
      `  ✓ ${e.recipientName}  ${formatUnits(e.amount)}  (${e.category})`,
    );
  }
  console.log(`  ${tick.notes.join(" / ")}`);
  console.log("");

  console.log("⑤ エージェント: 四国ラウンドロビン ×3");
  const rr = new AutonomousKosenAgent(fund, {
    mode: "round-robin",
    region: "四国",
    category: "scholarship",
    roundRobinAmount: "15000",
  });
  rr.run(3);
  console.log(rr.report());
  console.log("");

  console.log("⑥ 最終状態");
  console.log(fund.summary());
  console.log(
    `登録高専数: ${listKosen().length} / 対象例(近畿): ${listKosen({ region: "近畿" }).map((k) => k.shortName).join(", ")}`,
  );
}

main();
