# FundOS

**JPYC（プログラマブル円）で動く自立駆動型ファンドのオペレーティングシステム**

FundOS は、[JPYC](https://jpyc.jp/)（日本円ステーブルコイン、1 JPYC = 1 円）を基軸資産とし、スマートコントラクトのポリシーエンジンと AI エージェントが協調して運用するファンド基盤です。

## なぜ JPYC か

| 観点 | JPYC を選ぶ理由 |
|---|---|
| **単位** | 1 JPYC = 1 円。ポリシー・レポートをそのまま円建てで設計できる |
| **プログラマブル** | ERC-20。ボルト・ポリシー・エージェントから送金・残高管理が可能 |
| **マルチチェーン** | Ethereum / Polygon / Avalanche で同一アドレス |
| **規制枠組み** | JPYC 株式会社が資金移動業者として発行（前払式支払手段） |

```
┌─────────────┐     提案      ┌──────────────────┐     検証      ┌─────────────┐
│  AI Agent   │ ────────────► │  Policy Engine   │ ────────────► │ JPYC Vault  │
│ (オフチェーン) │               │  (オンチェーン)    │   OK なら実行  │  (fJPYC)    │
└─────────────┘               └──────────────────┘               └─────────────┘
       ▲                              │ 違反時
       │                              ▼
       │                       人間レビュー / pause
       └──────────────────────────────────────────────────────────
```

## JPYC 仕様

| 項目 | 値 |
|---|---|
| シンボル | JPYC |
| デシマル | **18**（1 円 = `1e18` wei 相当） |
| コントラクト (v2) | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` |
| 対応チェーン | Ethereum, Polygon, Avalanche |

## リポジトリ構成

```
contracts/
  src/constants/JPYC.sol   # アドレス・yen() ヘルパー
  src/AutonomousFundVault.sol
  src/PolicyEngine.sol
  src/FundFactory.sol
  script/DeployJPYCFund.s.sol
agent/
  src/jpyc.ts              # チェーン解決・円フォーマット
  src/orchestrator.ts      # 実行ループ
```

## ポリシー設定例（円建て）

```solidity
import {JPYC} from "./constants/JPYC.sol";

IPolicyEngine.PolicyConfig({
    minCashReserveBps: 1000,              // 総資産の 10% を JPYC 現金で保持
    maxTransferBps: 2000,                 // 1 回の送金は総資産の 20% まで
    dailySpendCap: JPYC.yen(10_000_000),  // 1 日 1,000 万円まで
    autonomousMode: true
});
```

## デプロイ

```bash
cd contracts
export ADMIN=0x...
export EXECUTOR=0x...
export JPYC_TOKEN=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29  # optional
forge script script/DeployJPYCFund.s.sol:DeployJPYCFund \
  --rpc-url $RPC_URL \
  --broadcast
```

## テスト

```bash
cd contracts && forge test -vv
```

テストは `MockJPYC`（18 decimals）で 1 億円規模のファンドをシミュレートします。

## エージェント実行

```bash
cd agent && npm install && npm run build

RPC_URL=https://... \
JPYC_NETWORK=ethereum \
VAULT_ADDRESS=0x... \
POLICY_ADDRESS=0x... \
EXECUTOR_PRIVATE_KEY=0x... \
YIELD_SINK=0x... \
npm run dev
```

`YIELD_SINK` は Phase 2 で接続する利回り先（Uniswap LP、Aave 等）のアドレスです。

## ロードマップ

| フェーズ | 内容 |
|---|---|
| ✅ Phase 1 | JPYC ボルト、ポリシーエンジン、エージェント骨格 |
| Phase 2 | JPYC ↔ 円建て DeFi（DEX スワップ、レンディング）、オラクル NAV |
| Phase 3 | ガバナンス、管理報酬・キャリー、円建て LP レポート |
| Phase 4 | KYC / 資金移動業連携、監査、メインネット本番 |

## コンプライアンス注意

JPYC ファンドは日本の資金決済法・金融商品取引法の対象となる可能性があります。本リポジトリは技術基盤であり、法務・会計判断は専門家にご相談ください。

## ライセンス

MIT
