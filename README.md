# FundOS — 高専生活動支援基金

**JPYC の利回りで、高専生の活動支援を続ける最小構成の基金。**

## やりたいこと

卒業生・支援者が JPYC を拠出 → 余剰資金を利回り運用 → 登録済みの学生ウォレットへ活動支援金を送る。

```
拠出 (JPYC) ──► KosenSupportFund ──► 利回り運用 (deployYield)
                      │
                      └──► 学生へ支援 (supportStudent)
```

## 最小構成（これだけ）

| ファイル | 役割 |
|---|---|
| `contracts/src/KosenSupportFund.sol` | 基金のすべて（拠出・利回り・支援） |
| `contracts/script/DeployKosenFund.s.sol` | Polygon デプロイ |
| `agent/src/run.ts` | 余剰 JPYC を利回り先へ送るエージェント |

**チェーン: Polygon**（JPYC 流通・ガス代のバランスが最良）

## 3 つの操作

| 誰 | 操作 | 関数 |
|---|---|---|
| 支援者 | JPYC を拠出 | `deposit()` |
| 管理者 | 学生ウォレットを登録 | `setGrantee()` |
| エージェント | 余剰 JPYC を利回りへ | `deployYield()` |
| エージェント | 活動支援金を送る | `supportStudent()` |

## 安全装置（オンチェーン）

- 現金準備: 総資産の **20%** 以上を JPYC で保持
- 1 回の支援: 総資産の **5%** まで
- 月間支援上限: **50 万円**（デプロイ時に変更可）
- 緊急停止: `pause()`

## クイックスタート

```bash
# テスト
cd contracts && forge test -vv

# デプロイ (Polygon)
export ADMIN=0x...
export EXECUTOR=0x...
export YIELD_SINK=0x...    # 利回り先（Phase 2: Aave/Uni LP）
export JPYC_TOKEN=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29
forge script script/DeployKosenFund.s.sol --rpc-url $RPC_URL --broadcast

# エージェント（週次 cron 等で実行）
cd agent && npm install && npm run dev
RPC_URL=... FUND_ADDRESS=... EXECUTOR_PRIVATE_KEY=0x... npm run dev
```

## Phase 2（必要になったら）

- 利回り先を Polygon 上の JPYC プール / レンディングに接続
- `totalAssets()` に利回りポジション残高を反映
- 支援申請 UI（オフチェーン）→ キュレーターが `setGrantee` + `supportStudent`

## ライセンス

MIT
