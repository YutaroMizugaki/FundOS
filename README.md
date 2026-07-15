# FundOS

**プログラマブルマネーで動く、自立駆動型の基金オペレーティングシステム。**

人がマンデート（目的）とポリシー（制約）を定め、エージェントが継続的に審査・実行・準備金管理を行う。

## コンセプト

| レイヤ | 役割 |
|--------|------|
| **Mandate** | 基金の存在理由・許可カテゴリ |
| **Policy** | 準備金フロア、単筆上限、カテゴリ制約などの実行可能ルール |
| **Vault** | 資金の保管と出金（オフチェーン台帳 / オンチェーン契約） |
| **Agent** | ポリシーに従い提案を自律承認・実行する自立駆動ループ |
| **Ledger** | すべての意思決定と資金移動の監査証跡 |

「プログラマブルマネー」= お金そのものにルールが埋め込まれ、人手の都度承認なしで安全に動く状態。

## クイックスタート

```bash
npm install
npm test          # コア + エージェント
npm run demo      # 自立駆動デモ（CLI）
npm run contracts:test  # オンチェーン FundVault
```

### デモで起きること

1. 200万 USDC 相当で基金を組成（準備金 20% を自動ロック）
2. 複数の助成提案を受付
3. 自律エージェントがポリシー評価 → 承認 / 却下 → 実行
4. マンデート外・上限超過は自動却下

```bash
npm run demo
```

## リポジトリ構成

```
packages/
  core/     # FundVault・PolicyEngine・Ledger（TypeScript）
  agent/    # AutonomousFundAgent（自立駆動ループ）
  cli/      # fundos demo
contracts/
  src/      # FundPolicy.sol / FundVault.sol（Solidity）
  test/     # Hardhat テスト
```

## オフチェーン API（抜粋）

```ts
import { FundVault, parseUnits } from "@fundos/core";
import { AutonomousFundAgent } from "@fundos/agent";

const fund = FundVault.create({
  name: "Climate Resilience Fund",
  mandate: {
    purpose: "Support climate adaptation",
    allowedCategories: ["climate", "research"],
  },
  reserveFloorRatio: 0.2,
  maxDisbursementRatio: 0.05,
  initialDeposit: parseUnits("1000000"),
});

fund.submitProposal({
  recipient: "SensorDAO",
  amount: parseUnits("30000"),
  category: "climate",
  rationale: "Coastal sensors",
});

const agent = new AutonomousFundAgent(fund, { autoExecute: true });
agent.run({ ticks: 1 });
```

## オンチェーン

- `FundPolicy` — 準備金・上限・カテゴリを bps で固定したポリシー契約
- `FundVault` — ETH を預かるデモ用ボルト。`executor`（エージェント鍵）がポリシー通過提案のみ実行可能

本番では ERC-20（USDC 等）対応・マルチエグゼキュータ・タイムロック付きガーディアンを足す想定。

## 設計原則

1. **Policy before people** — ルーチン出金はポリシーが決める。人は例外とパラメータ変更に集中する
2. **Re-check at execution** — 承認時だけでなく実行時にもポリシー再評価
3. **Reserve floor** — NAV の一定割合を常に確保し、基金の持続性を守る
4. **Full audit trail** — エージェントの tick も含め台帳に残す

## ライセンス

MIT
