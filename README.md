# FundOS — 高専ピッチ基金

**拠出者が投票権を持ち、高専生がプレゼンし、票で支援が配分される** プログラマブルマネー MVP。

```
拠出（= 投票権） → 学生ピッチ → 投票 → 按分執行
```

## モデル

| 役割 | すること |
|------|----------|
| **拠出者** | 基金に入金し、同量の投票権を得る |
| **学生** | 所属高専・要旨・希望額でピッチ（プレゼン）を提出 |
| **ラウンド** | ピッチ受付 → 投票 → 確定。票の比率で予算を按分 |
| **ポリシー** | 準備金・単筆上限・月次キャップ・マンデートで安全側に倒す |

配分式（MVP）:

```
payout_i = min(requested_i, budget × votes_i / Σvotes)
```

## クイックスタート

```bash
npm install
npm test
npm run demo    # CLI: 拠出→ピッチ→投票→確定
npm run dev     # Web ライブ・アリーナ
```

## リポジトリ

```
packages/core   … FundVault（contribute / pitch / vote / settle）
packages/kosen  … 高専レジストリ + 学生ピッチヘルパー
packages/agent  … PitchVoteAgent
apps/web        … ランディング + ライブ・アリーナ
```

## コード例

```ts
import { parseUnits } from "@fundos/core";
import {
  createKosenFund,
  openPitchRound,
  submitStudentPitch,
} from "@fundos/kosen";

const fund = createKosenFund();
const alice = fund.contribute({ name: "Alice", amount: parseUnits("200000") });

const round = openPitchRound(fund, "春ピッチ", { budgetRatio: 0.5 });
const pitch = submitStudentPitch(fund, {
  roundId: round.id,
  studentName: "佐藤",
  kosenId: "kosen_tokyo",
  title: "水中ドローン",
  abstract: "湖沼調査用プロトタイプ",
  category: "research",
  requestedAmount: parseUnits("70000"),
});

fund.openVoting(round.id);
fund.castVote(round.id, alice.id, [
  { pitchId: pitch.id, weight: alice.votingPower },
]);
fund.settle(round.id);
```

## 次のステップ

- プレゼン当日のタイムボックス / ライブ投票 UI
- 二乗投票（Quadratic Voting）やマッチングファンド
- 実口座・ステーブルコイン送金
- オンチェーン化（投票・執行の公開性）

## ライセンス

Private / TBD
