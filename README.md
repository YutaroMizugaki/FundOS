# FundOS — 高専拠出基金

プログラマブルマネーで動く、**高等専門学校（高専）への自立駆動型拠出** MVP。

人がマンデート（目的）とポリシー（制約）を定め、エージェントがポリシー境界内だけで審査・執行します。

## いまできること

- 高専レジストリ（全国の国立高専を中心に登録）
- 基金ボルト（預金・準備金・台帳）
- ポリシーエンジン（準備金フロア / 単筆上限 / 月次キャップ / マンデート）
- 自立駆動エージェント（均等拠出・ラウンドロビン・保留案件処理）
- Web ライブ・コンソール（地域を選んでサイクル実行）

## クイックスタート

```bash
npm install
npm test          # core / kosen / agent
npm run demo      # CLI 自立駆動デモ
npm run dev       # Web UI (http://localhost:5173)
```

## アーキテクチャ

```
packages/core   … FundVault / PolicyEngine / Ledger
packages/kosen  … 高専レジストリ + 拠出サイクル
packages/agent  … AutonomousKosenAgent
apps/web        … ランディング + ライブ・コンソール
```

### マンデート（MVP）

| 項目 | 内容 |
|------|------|
| 対象 | 日本の高等専門学校 |
| カテゴリ | `equipment` / `scholarship` / `research` / `competition` |
| 準備金 | 既定 25% |
| 単筆上限 | NAV の 4% |
| 月次上限 | NAV の 8% |

## コード例

```ts
import { parseUnits } from "@fundos/core";
import { createKosenFund, submitKosenGrant } from "@fundos/kosen";
import { AutonomousKosenAgent } from "@fundos/agent";

const fund = createKosenFund({ initialDeposit: parseUnits("5000000") });

submitKosenGrant(fund, {
  kosenId: "kosen_tokyo",
  amount: parseUnits("25000"),
  category: "competition",
  rationale: "高専ロボコン出場機材",
});
fund.autoProcess(fund.pendingProposals()[0]!.id);

const agent = new AutonomousKosenAgent(fund, {
  mode: "equal-share",
  region: "東海",
  category: "equipment",
});
agent.tick();
```

## 安全モデル

完全無人ではなく **Policy-Bounded Autonomy（ポリシー境界内自律）** です。

- マンデート外は自動却下
- 準備金・単筆・月次上限で流出を制限
- `pause` で緊急停止
- すべての決定と送金を台帳に記録

## 次のステップ

1. 実在の高専口座 / 寄付窓口との接続（銀行 API・ステーブルコイン）
2. マルチシグ管理者とタイムロック
3. オンチェーン Vault（他ブランチの契約層と統合）
4. 法人格・寄付規制・税務の整理

## ライセンス

Private / TBD
