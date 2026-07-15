# FundOS

**プログラマブルマネーを基盤にした自立駆動型（自律実行型）の基金プロトコル**

FundOS は、ステーブルコインなどの ERC20（プログラマブルマネー）を出資として受け入れ、
あらかじめコードで定義されたルール（Strategy）に従って、人の承認を都度必要とせずに
資金を自動的に運用・分配する、オンチェーンの自律型基金です。

## コンセプト

- **プログラマブルマネー**: 基金が扱う資産は ERC20 トークン（例: USDC / USDT / DAI 等の
  ステーブルコイン）。転送ロジック自体がプログラム可能であることを前提にしています。
- **自立駆動（Autonomous / Self-Driving）**: 基金の「次に何をするか」を決めるロジックは
  `IFundStrategy` というプラグイン可能なコントラクトに切り出され、`FundVault.autoExecute()`
  は **誰でも（許可不要で）** 呼び出せます。ボット・Chainlink Automation のようなキーパー・
  cron ジョブなど、何が呼んでも構いません。基金は人手を介さず自走します。
- **ガバナンスと安全性の両立**: 戦略の切り替えや設定変更（`setStrategy` /
  `setReserveRatioBps` / `pause` など）は `onlyOwner` に制限されています。`owner` に
  `TimelockController` を設定することで、変更は「予告 (schedule) → 遅延 → 実行 (execute)」
  という透明なプロセスを経ないと反映されない仕組みになっています。単一の秘密鍵が即座に
  資金の流れ先を変えられないようにするための安全弁です。

## アーキテクチャ

```
contracts/
├── IFundStrategy.sol                 自律実行される戦略の共通インターフェース
├── FundVault.sol                     ERC4626 準拠の金庫本体（出資・受益権・自動実行トリガー）
├── StreamingDistributionStrategy.sol サンプル戦略：受益者へ重み付きで自動的に資金を分配
├── mocks/MockERC20.sol               テスト用のプログラマブルマネー（ステーブルコイン）モック
└── dependencies/GovernanceDependencies.sol  TimelockController のアーティファクト生成用
```

### FundVault

- [OpenZeppelin `ERC4626`](https://docs.openzeppelin.com/contracts/5.x/erc4626) を継承した
  トークン化金庫。出資者は `deposit` / `mint` で資産を入れ、`withdraw` / `redeem` で引き出せます。
- `idleAssets()`: `reserveRatioBps`（デフォルト 20%）を引き出し用に残した上で、戦略が
  使ってよい「アイドル資産」を計算します。
- `autoExecute()`: 誰でも呼び出せる自律実行トリガー。現在の戦略に対して
  `shouldExecute` で実行すべきか判定させ、`true` ならアイドル資産分の allowance を
  戦略に一時的に付与して `execute` を呼び、実行後に allowance を 0 に戻します。
- `setStrategy` / `setReserveRatioBps` / `pause` / `unpause`: いずれも `onlyOwner`。

### IFundStrategy / StreamingDistributionStrategy

- `IFundStrategy` は「今アイドル資産で何かすべきか (`shouldExecute`)」「実際に何をするか
  (`execute`)」「最小実行間隔 (`minInterval`)」を定義するだけの薄いインターフェースです。
  新しい自律運用ルール（リバランス、外部プロトコルへのデプロイ、ストリーミング決済など）は
  このインターフェースを実装するだけで `FundVault` に差し替え可能です。
- サンプル実装 `StreamingDistributionStrategy` は、固定の受益者リストへ重み比率
  (`weightBps`、合計 10,000 = 100%) でアイドル資産を分配する「自動給与 / 助成金ストリーム」です。
  `minIntervalSeconds` 未満の頻度では再実行できません。

### ガバナンス（TimelockController）

`scripts/deploy.ts` は `FundVault` と `StreamingDistributionStrategy` の `owner` に
OpenZeppelin の `TimelockController` を設定する例を含みます。これにより:

1. 変更を提案する側は `timelock.schedule(...)` を呼ぶ
2. `minDelay` の間、誰でもその提案内容を確認できる（オンチェーンで透明）
3. `minDelay` 経過後に初めて `timelock.execute(...)` で反映される

という流れになり、基金が「自律的に動く」一方で、そのルール自体を変える権限は
即時発動できない構造になっています。

## セットアップ

```bash
npm install
npx hardhat compile
npx hardhat test
```

ローカルネットワークへのデプロイ例:

```bash
npx hardhat node
npx hardhat run scripts/deploy.ts --network localhost
```

## テスト内容

- `test/FundVault.test.ts`: 出資/引き出しの ERC4626 会計、`reserveRatioBps` によるアイドル
  資産計算、`autoExecute` が誰でも呼べること・最小実行間隔・`pause` の挙動、
  `onlyOwner` 系の権限チェック。
- `test/StreamingDistributionStrategy.test.ts`: 受益者の重みが合計 10,000 でなければ
  デプロイ/更新が失敗すること、ゼロアドレス拒否、`onlyOwner` によるオーナー保護。
- `test/Governance.test.ts`: `TimelockController` を `owner` に設定した場合、
  直接の `setStrategy` 呼び出しが失敗し、`schedule` → 待機 → `execute` の手順を踏んだ
  場合のみ反映されることを検証。

## 拡張のアイデア

- `IFundStrategy` を実装した新しい戦略（例: Chainlink Price Feed を見た自動リバランス、
  Aave/Compound など外部プロトコルへの自動デプロイ、時間経過に応じた連続的なストリーミング
  支払い）を追加し、ガバナンス経由で `setStrategy` に差し替える。
- `autoExecute` を Chainlink Automation の `AutomationCompatibleInterface`
  (`checkUpkeep` / `performUpkeep`) でラップし、完全に自動でキーパーに実行させる。
- マルチアセット対応（複数の ERC20 を保有する基金）や、NAV に応じた動的な
  `reserveRatioBps` 調整ロジックの追加。
