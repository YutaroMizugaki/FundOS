#!/usr/bin/env node
import { formatUnits, parseUnits } from "@fundos/core";
import { PitchVoteAgent } from "./agent.js";

function main(): void {
  console.log("FundOS — 高専ピッチ投票デモ\n");
  console.log("流れ: 拠出（投票権）→ 学生プレゼン → 投票 → 按分執行\n");

  const agent = PitchVoteAgent.bootstrap();
  const seeded = agent.seedDemo("2026 春・高専ピッチデー");
  console.log("① 拠出者と学生ピッチを準備");
  console.log(
    `  拠出者 ${seeded.contributorCount} / ピッチ ${seeded.pitchCount} / round ${seeded.roundId}`,
  );
  console.log(agent.fund.summary());
  console.log("");

  console.log("② 学生プレゼン一覧");
  for (const p of agent.fund.pitchesForRound(seeded.roundId)) {
    console.log(
      `  · ${p.studentName}（${p.schoolName}）「${p.title}」希望 ${formatUnits(p.requestedAmount)}`,
    );
    console.log(`    ${p.abstract}`);
  }
  console.log("");

  console.log("③ 拠出者が投票 → ラウンド確定");
  const result = agent.settleWithHeuristic();
  for (const p of result.pitches) {
    const mark = p.fundedAmount > 0n ? "✓" : "·";
    console.log(
      `  ${mark} ${p.studentName}  票=${formatUnits(p.votesReceived)}  配分=${formatUnits(p.fundedAmount)}  [${p.status}]`,
    );
  }
  console.log("");

  console.log("④ 追加ピッチを手動で拒否される例（マンデート外）");
  try {
    const fund = agent.fund;
    fund.contribute({ name: "新規拠出者", amount: parseUnits("50000") });
    // need new round
    const round = fund.openRound({
      title: "次ラウンド",
      budgetRatio: 0.3,
    });
    fund.submitPitch({
      roundId: round.id,
      studentName: "誰か",
      schoolId: "corp",
      schoolName: "無関係",
      title: "土地購入",
      abstract: "x",
      category: "real-estate",
      requestedAmount: parseUnits("10000"),
    });
  } catch (e) {
    console.log(`  → 期待どおり却下: ${(e as Error).message}`);
  }
  console.log("");

  console.log("⑤ 最終レポート");
  console.log(agent.report());
}

main();
