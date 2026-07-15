#!/usr/bin/env node
import {
  FundVault,
  formatUnits,
  parseUnits,
  serializeLedgerForJson,
} from "@fundos/core";
import { AutonomousFundAgent } from "@fundos/agent";

function printHelp(): void {
  console.log(`FundOS — programmable autonomous fund CLI

Usage:
  fundos demo          Run an end-to-end autonomous fund simulation
  fundos help          Show this help
`);
}

function runDemo(): void {
  const fund = FundVault.create({
    id: "fundos-demo-001",
    name: "自立駆動デモ基金",
    baseAsset: "USDC",
    mandate: {
      purpose: "ポリシーに従い、人手なしで助成を審査・実行する",
      allowedCategories: ["public-goods", "climate", "education"],
      scope: "global",
    },
    reserveFloorRatio: 0.2,
    maxDisbursementRatio: 0.05,
    initialDeposit: parseUnits("2000000"),
  });

  const submissions = [
    {
      recipient: "OpenClimateKit",
      amount: parseUnits("50000"),
      category: "climate",
      rationale: "オープン気候データ基盤",
    },
    {
      recipient: "CivicEduJP",
      amount: parseUnits("40000"),
      category: "education",
      rationale: "プログラマブルマネー教育コンテンツ",
    },
    {
      recipient: "MegaCorpAds",
      amount: parseUnits("30000"),
      category: "marketing",
      rationale: "マンデート外",
    },
    {
      recipient: "TooBigDAO",
      amount: parseUnits("200000"),
      category: "public-goods",
      rationale: "上限超過の申請",
    },
  ] as const;

  for (const s of submissions) {
    fund.submitProposal({ ...s });
  }

  const agent = new AutonomousFundAgent(fund, {
    autoExecute: true,
    log: (m) => console.log(`  ${m}`),
  });

  console.log("╔══════════════════════════════════════════╗");
  console.log("║     FundOS — 自立駆動型基金デモ          ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`基金名:   ${fund.config.name}`);
  console.log(`目的:     ${fund.config.mandate.purpose}`);
  console.log(`基軸:     ${fund.config.baseAsset}`);
  console.log(`初期NAV:  ${formatUnits(fund.getNav())}`);
  console.log(`準備金:   ${fund.config.reserveFloorRatio * 100}%`);
  console.log(`単筆上限: ${fund.config.maxDisbursementRatio * 100}% of NAV`);
  console.log("");
  console.log("→ 自律エージェントがポリシーに基づき審査・実行します…");
  console.log("");

  agent.run({ ticks: 1 });

  console.log("");
  console.log("─ 提案結果 ─");
  for (const p of fund.getProposals()) {
    const mark =
      p.status === "executed" ? "✓" : p.status === "rejected" ? "✗" : "·";
    console.log(
      `  ${mark} ${p.status.padEnd(9)} ${formatUnits(p.amount).padStart(12)} → ${p.recipient} [${p.category}]`,
    );
    if (p.decisionReason) {
      console.log(`      reason: ${p.decisionReason}`);
    }
  }

  const state = fund.getState();
  console.log("");
  console.log("─ 基金状態 ─");
  console.log(`  NAV:      ${formatUnits(fund.getNav())} ${fund.config.baseAsset}`);
  console.log(`  Cash:     ${formatUnits(state.cash)}`);
  console.log(`  Reserved: ${formatUnits(state.reserved)}`);
  console.log(`  Outflows: ${formatUnits(state.totalOutflows)}`);
  console.log(`  Ledger:   ${fund.getLedger().list().length} entries`);

  // Machine-readable footer for piping
  if (process.env.FUNDOS_JSON === "1") {
    console.log(
      JSON.stringify(
        {
          snapshot: {
            ...fund.snapshot(),
            state: {
              ...state,
              cash: state.cash.toString(),
              reserved: state.reserved.toString(),
              totalInflows: state.totalInflows.toString(),
              totalOutflows: state.totalOutflows.toString(),
            },
            proposals: fund.getProposals().map((p) => ({
              ...p,
              amount: p.amount.toString(),
            })),
            ledger: serializeLedgerForJson(fund.getLedger().list()),
          },
        },
        null,
        2,
      ),
    );
  }
}

const cmd = process.argv[2] ?? "demo";
if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
} else if (cmd === "demo") {
  runDemo();
} else {
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}
