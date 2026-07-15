# FundOS

**プログラマブルマネーで動く、自立駆動型（自動運転）の基金エンジン。**
_A programmable-money engine for building self-driving (autonomous) funds._

FundOS は、人手を介さずにルールだけで運用・分配される「基金（ファンド）」を作るための
TypeScript ライブラリです。お金そのものに条件（ポリシー）を埋め込む **プログラマブルマネー**
の層と、時間の経過に合わせて自動的に運用判断を下す **オートパイロット（ルールエンジン）** を
組み合わせています。寄付や拠出を受け取ると、あとは基金が自分自身で

- 拠出金を運用に回し（sweep / allocation）、
- 収益を複利で積み上げ（yield）、
- 目標配分へ自動リバランスし、
- 4%ルールのような支出方針に沿って受益者へ分配し、
- 準備金が枯渇しそうになれば自動的に分配を止める（サーキットブレーカー）

という一連の動作を、誰も操作しなくても継続します。

---

## なぜ「プログラマブルマネー」か / Why programmable money?

通常のお金は「誰の残高がいくら」という情報しか持ちません。FundOS では、お金の移動
（`TransferIntent`）が必ず **口座に付与されたポリシー** を通過します。これにより、お金自身に
「何のためのお金か」「どこへ送ってよいか」「いつ解放されるか」といったルールを持たせられます。

| ポリシー | 役割 |
| --- | --- |
| `AllowListPolicy` | 許可した宛先にしか送れない |
| `DenyListPolicy` | 制裁・凍結先への送金を拒否 |
| `TimeLockPolicy` | 指定時刻までロック（ベスティング等） |
| `SpendingLimitPolicy` | ローリングウィンドウの支出上限 |
| `EarmarkPolicy` | 用途タグが一致する送金のみ許可（使途限定） |
| `FeePolicy` | 送金ごとに手数料を原子的に徴収 |

すべての送金・手数料は **アトミック**：ポリシー違反や残高不足があれば、その取引は一切実行
されず残高は変化しません。

---

## アーキテクチャ / Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ 3. Autopilot（自立駆動）  AutonomousEngine + Rules            │
│    SweepRule / TargetAllocationRule / YieldRule /            │
│    SpendingRule / ReserveFloorGuard                          │
│    └── SimulationClock が tick を自動発火（self-driving loop）│
├─────────────────────────────────────────────────────────────┤
│ 2. Autonomous Fund       Fund                                │
│    バケット / 持分(shares) / NAV / 拠出・償還               │
├─────────────────────────────────────────────────────────────┤
│ 1. Programmable Money     Ledger + MoneyPolicy               │
│    口座残高 / アトミックな送金 / ポリシー実行               │
└─────────────────────────────────────────────────────────────┘
```

- **時間で自走する**: `SimulationClock` は決定論的なスケジューラです。`advanceTo()` で時間を
  進めると、期限が来たタスク（＝エンジンの `tick`）が時系列順に発火します。同じループを実時間で
  駆動すれば本番運用にも使えます。
- **金額は整数（`bigint`）**: 通貨の最小単位（例: セント）で表現し、浮動小数点の誤差を排除。
- **監査可能**: すべての状態変化は `EventLog` に追記され、後から再生・集計できます。無人運転の
  基金にとって不可欠な監査証跡になります。

---

## クイックスタート / Quick start

```bash
npm install
npm test          # 32 個のユニットテスト
npm run demo      # 10 年間の自立駆動シミュレーション（examples/endowment.ts）
npm run cli -- --years 20 --gift 1000000 --yield-bps 700 --spend-bps 350
npm run build     # dist/ に型定義付きで出力
```

### コード例：自立駆動型の永久奨学基金

```ts
import {
  AutonomousEngine, Fund, Ledger, MS_PER_DAY, MS_PER_YEAR,
  ReserveFloorGuard, SimulationClock, SpendingRule, SweepRule,
  TargetAllocationRule, YieldRule,
} from "fundos";

const clock = new SimulationClock(Date.UTC(2026, 0, 1));
const ledger = new Ledger(clock);

// 寄付者と受益者（外部口座）
const donor = ledger.open({ label: "donor" });
const scholarships = ledger.open({ label: "scholarships" });
ledger.mint(donor.id, 5_000_000_00n); // $5,000,000（セント単位）

// 基金本体（3 つのトレジャリーバケット）
const fund = new Fund({
  name: "Perpetual Endowment",
  ledger, clock,
  buckets: [{ name: "intake" }, { name: "growth" }, { name: "reserve" }],
  intakeBucket: "intake",
  liquidBucket: "reserve",
});

// オートパイロットのルール群を登録
const engine = new AutonomousEngine(fund, clock).register(
  new ReserveFloorGuard({ watchBucket: "reserve", floor: 1_000_00n }), // 枯渇防止
  new SweepRule("intake", "growth"),                                   // 拠出を運用へ
  new YieldRule({ bucket: "growth", annualBps: 600n }),                // 年6%複利
  new TargetAllocationRule({ weights: { growth: 9_000n, reserve: 1_000n }, driftBps: 50n }),
  new SpendingRule({                                                   // 4%ルール
    sourceBucket: "reserve",
    periodMs: 30 * MS_PER_DAY,
    annualSpendBps: 400n,
    beneficiaries: [{ account: scholarships.id, weightBps: 10_000n, purpose: "scholarship" }],
  }),
);

// 時計に接続すると、以後は無人で自走する
engine.autopilot(clock, 7 * MS_PER_DAY);

fund.contribute(donor.id, 5_000_000_00n, "founding gift");
clock.advanceTo(Date.UTC(2026, 0, 1) + 10 * MS_PER_YEAR); // 10 年進める

console.log(fund.snapshot());
```

`clock.advanceTo(...)` を呼ぶだけで、10 年分の運用・複利・リバランス・毎月の分配・
必要時の自動停止がすべて自律的に実行されます。

---

## ルール一覧 / Autonomous rules

| ルール | 動作 |
| --- | --- |
| `SweepRule(from, to)` | 遊休中の拠出金を運用バケットへ移動 |
| `TargetAllocationRule({weights, driftBps})` | 目標配分へ自動リバランス（乖離が閾値超過時のみ） |
| `YieldRule({bucket, annualBps})` | 経過時間に比例して収益（損失）を計上 |
| `SpendingRule({...})` | 毎期、資産の年率一定割合を受益者へ分配（元本は温存） |
| `ReserveFloorGuard({watchBucket, floor})` | 準備金が下限を割ると分配を停止、回復で再開 |

ルールは **tick 間隔に依存しません**（経過時間から按分計算するため）。tick を毎日回しても
毎週回しても、年率の意味は保たれます。独自ルールは `Rule` インターフェースを実装するだけで
追加できます。

---

## npm scripts

| script | 説明 |
| --- | --- |
| `npm test` | `node --test` によるユニットテスト |
| `npm run typecheck` | 型チェックのみ（`--noEmit`） |
| `npm run build` | `dist/` へコンパイル（型定義・ソースマップ付き） |
| `npm run demo` | 奨学基金の 10 年シミュレーション |
| `npm run cli -- [options]` | CLI シミュレータ（`--help` 参照） |

## Layout

```
src/
  clock.ts          # SimulationClock + scheduler（自走ループ）
  events.ts         # 追記式イベントログ（監査証跡）
  money/            # プログラマブルマネー層
    types.ts        #   TransferIntent / MoneyPolicy / PolicyViolation
    policies.ts     #   AllowList / DenyList / TimeLock / SpendingLimit / Earmark / Fee
    ledger.ts       #   口座・残高・アトミック送金
  fund/             # 自立駆動型ファンド層
    fund.ts         #   バケット・持分・NAV・拠出/償還
    engine.ts       #   AutonomousEngine（オートパイロット）
    rules.ts        #   運用ルール群
  cli.ts            # コマンドラインシミュレータ
  index.ts          # 公開 API
examples/endowment.ts
test/               # 32 tests
```

## License

MIT
