# FundOS

**プログラマブルマネーで動く自立駆動型ファンド（自律運用基金）のオペレーティングシステム**

FundOS は、オンチェーンのプログラマブルマネー（ステーブルコイン等）を資本として、スマートコントラクトのポリシーエンジンと AI エージェントが協調して運用するファンド基盤です。

## コンセプト

従来のファンド運用は「人が判断し、人が署名する」モデルです。FundOS は **ポリシー境界内自律（Policy-Bounded Autonomy）** を採用します。

```
┌─────────────┐     提案      ┌──────────────────┐     検証      ┌─────────────┐
│  AI Agent   │ ────────────► │  Policy Engine   │ ────────────► │   Vault     │
│ (オフチェーン) │               │  (オンチェーン)    │   OK なら実行  │ (プログラマブル │
└─────────────┘               └──────────────────┘               │  マネー保管)  │
       ▲                              │ 違反時                      └─────────────┘
       │                              ▼
       │                       人間レビュー / 一時停止
       └──────────────────────────────────────────────────────────
```

- **エージェント**: 市場状態を読み、リバランス等を提案
- **ポリシーエンジン**: 資産ホワイトリスト、最低現金比率、1 回あたり上限、日次支出上限を強制
- **ボルト**: ERC-4626 準拠のファンド金庫。LP はシェアを通じて出資・償還

ポリシー違反時はオンチェーンで拒否され、キルスイッチ（`pause`）で全操作を停止できます。

## リポジトリ構成

```
contracts/          # Solidity (Foundry) — ボルト・ポリシー・ファクトリ
agent/              # TypeScript — 戦略エージェントと実行オーケストレータ
```

## スマートコントラクト

| コントラクト | 役割 |
|---|---|
| `AutonomousFundVault` | ERC-4626 ボルト。`executeManagedTransfer` でエージェントが政策内送金 |
| `PolicyEngine` | 自律モード、資産制限、リザーブ・上限・日次キャップ |
| `FundFactory` | ボルト + ポリシーをワンクリックデプロイ |
| `IPolicyEngine` | ポリシーインターフェース |

### ポリシー設定例

```solidity
IPolicyEngine.PolicyConfig({
    minCashReserveBps: 1000,   // 総資産の 10% を現金で保持
    maxTransferBps: 2000,      // 1 回の送金は総資産の 20% まで
    dailySpendCap: 500_000e6,  // 1 日の累計支出上限 (USDC 6 decimals)
    autonomousMode: true       // エージェント自律実行を許可
});
```

## エージェント層

`agent/` パッケージはオフチェーンの実行ループです。

1. オンチェーン状態（総資産、現金残高、ポリシー）を読み取る
2. `TargetWeightStrategy` がリバランス提案を生成
3. ポリシー内なら `executeManagedTransfer` を送信（`reasonHash` で監査証跡）

### ローカル実行

```bash
# コントラクトテスト
cd contracts && forge test -vv

# エージェント
cd agent && npm install && npm run build
RPC_URL=http://127.0.0.1:8545 \
VAULT_ADDRESS=0x... \
POLICY_ADDRESS=0x... \
EXECUTOR_PRIVATE_KEY=0x... \
YIELD_SINK=0x... \
BASE_ASSET=0x... \
npm run dev
```

## 開発ロードマップ

| フェーズ | 内容 |
|---|---|
| ✅ Phase 1 | ボルト MVP、ポリシーエンジン、エージェント骨格 |
| Phase 2 | オラクル連携によるマルチアセット NAV、DEX スワップ実行 |
| Phase 3 | ガバナンス（マルチシグ / トークン投票）、手数料ウォーターフォール |
| Phase 4 | LP 向けレポーティング、KYC ゲート、監査・メインネット |

## ライセンス

MIT
