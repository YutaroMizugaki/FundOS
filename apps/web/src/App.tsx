import { useRef, useState } from "react";
import {
  formatUnits,
  parseUnits,
  type DisbursementProposal,
  type FundVault,
} from "@fundos/core";
import {
  createKosenFund,
  listKosen,
  runRoundRobinGrant,
  type KosenRegion,
} from "@fundos/kosen";
import { AutonomousKosenAgent } from "@fundos/agent";

type LogKind = "info" | "ok" | "bad";

interface LogLine {
  id: string;
  kind: LogKind;
  text: string;
}

const REGIONS: Array<KosenRegion | "全国"> = [
  "全国",
  "北海道",
  "東北",
  "関東信越",
  "北陸",
  "東海",
  "近畿",
  "中国",
  "四国",
  "九州沖縄",
];

function createDemoFund(): FundVault {
  return createKosenFund({
    initialDeposit: parseUnits("5000000"),
    reserveFloorRatio: 0.25,
    maxDisbursementRatio: 0.04,
    monthlySpendCapRatio: 0.08,
  });
}

export function App() {
  const [fund, setFund] = useState(() => createDemoFund());
  const [region, setRegion] = useState<KosenRegion | "全国">("東海");
  const cursorRef = useRef(0);
  const [logs, setLogs] = useState<LogLine[]>([
    {
      id: "boot",
      kind: "info",
      text: "FundOS 高専拠出基金を起動（デモ・オフチェーン台帳）",
    },
  ]);
  const [, bump] = useState(0);
  const refresh = () => {
    setFund(fund);
    bump((n) => n + 1);
  };

  const summary = fund.summary();
  const state = fund.getState();
  const schools = region === "全国" ? listKosen() : listKosen({ region });
  const executed = state.proposals.filter((p) => p.status === "executed");

  const pushLog = (kind: LogKind, text: string) => {
    setLogs((prev) =>
      [
        { id: `${Date.now()}_${Math.random()}`, kind, text },
        ...prev,
      ].slice(0, 40),
    );
  };

  const runCycle = () => {
    const agent = new AutonomousKosenAgent(fund, {
      mode: "equal-share",
      region: region === "全国" ? undefined : region,
      category: "equipment",
      perSchoolCap: "30000",
    });
    const result = agent.tick();
    for (const e of result.executed) {
      pushLog(
        "ok",
        `実行 ${e.recipientName} +${formatUnits(e.amount)} (${e.category})`,
      );
    }
    for (const r of result.rejected) {
      pushLog("bad", `却下 ${r.recipientName}: ${r.decisionReason ?? ""}`);
    }
    if (result.executed.length === 0 && result.rejected.length === 0) {
      pushLog("info", result.notes.join(" / ") || "拠出可能な枠がありません");
    } else {
      pushLog("info", result.notes.join(" / "));
    }
    refresh();
  };

  const runRoundRobin = () => {
    const target = region === "全国" ? listKosen() : listKosen({ region });
    const { nextCursor, proposal } = runRoundRobinGrant(
      fund,
      cursorRef.current,
      {
        amount: parseUnits("15000"),
        category: "scholarship",
        schools: target,
      },
    );
    cursorRef.current = nextCursor;
    if (proposal?.status === "executed") {
      pushLog(
        "ok",
        `RR 実行 ${proposal.recipientName} +${formatUnits(proposal.amount)}`,
      );
    } else if (proposal) {
      pushLog(
        "bad",
        `RR 却下 ${proposal.recipientName}: ${proposal.decisionReason ?? ""}`,
      );
    } else {
      pushLog("info", "対象校がありません");
    }
    refresh();
  };

  const togglePause = () => {
    if (state.status === "active") {
      fund.pause("UI から緊急停止");
      pushLog("bad", "基金を一時停止しました");
    } else if (state.status === "paused") {
      fund.resume("UI から再開");
      pushLog("ok", "基金を再開しました");
    }
    refresh();
  };

  const reset = () => {
    const fresh = createDemoFund();
    setFund(fresh);
    cursorRef.current = 0;
    setLogs([
      {
        id: "reset",
        kind: "info",
        text: "デモ基金をリセットしました（NAV 5,000,000）",
      },
    ]);
    bump((n) => n + 1);
  };

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__bg" aria-hidden />
        <nav className="nav">
          <div className="nav__brand">
            Fund<span>OS</span>
          </div>
          <div className="nav__links">
            <a href="#how">仕組み</a>
            <a href="#live">ライブ</a>
            <a href="#safety">安全策</a>
          </div>
        </nav>
        <div className="hero__content">
          <h1 className="hero__brand">
            Fund<em>OS</em>
          </h1>
          <p className="hero__subbrand">高専拠出基金</p>
          <p className="hero__lede">
            プログラマブルマネーにルールを埋め込み、高等専門学校へ設備・奨学金・研究・競技支援を自立駆動で届ける。
          </p>
          <div className="cta-row">
            <a className="btn btn--primary" href="#live">
              デモを動かす
            </a>
            <a className="btn btn--ghost" href="#how">
              仕組みを見る
            </a>
          </div>
        </div>
      </header>

      <section className="how" id="how">
        <div className="section__head">
          <h2>人がマンデートを決め、基金が執行する</h2>
          <p>
            高専への拠出目的と上限をコード化し、エージェントがポリシー境界内だけで審査・送金する。
          </p>
        </div>
        <div className="flow">
          <article className="flow__item">
            <h3>マンデート</h3>
            <p>
              対象は日本の高専。カテゴリは設備・奨学金・研究・競技に限定。
            </p>
          </article>
          <article className="flow__item">
            <h3>ポリシー</h3>
            <p>
              準備金フロア、単筆上限、月次支出キャップで資産を守りながら自動執行。
            </p>
          </article>
          <article className="flow__item">
            <h3>自立駆動</h3>
            <p>
              均等拠出やラウンドロビンで全国・地域サイクルを回し、台帳に監査証跡を残す。
            </p>
          </article>
        </div>
      </section>

      <section className="console" id="live">
        <div className="section__head">
          <h2>ライブ・コンソール</h2>
          <p>
            オフチェーンのデモ金庫です。地域を選んで月次サイクルを実行できます。
          </p>
        </div>
        <div className="console__grid">
          <div>
            <div className="metrics">
              <div className="metric">
                <span className="metric__label">Status</span>
                <span
                  className={`metric__value ${summary.status === "active" ? "metric__value--accent" : "metric__value--brass"}`}
                >
                  {summary.status}
                </span>
              </div>
              <div className="metric">
                <span className="metric__label">NAV</span>
                <span className="metric__value">{summary.nav}</span>
              </div>
              <div className="metric">
                <span className="metric__label">Cash</span>
                <span className="metric__value metric__value--accent">
                  {summary.cash}
                </span>
              </div>
              <div className="metric">
                <span className="metric__label">Executed</span>
                <span className="metric__value metric__value--brass">
                  {summary.executed}
                </span>
              </div>
            </div>

            <div className="controls">
              <div className="field">
                <label htmlFor="region">対象地域</label>
                <select
                  id="region"
                  value={region}
                  onChange={(e) =>
                    setRegion(e.target.value as KosenRegion | "全国")
                  }
                >
                  {REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={runCycle}
              >
                均等拠出を実行
              </button>
              <button
                type="button"
                className="btn btn--brass"
                onClick={runRoundRobin}
              >
                1校ラウンドロビン
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={togglePause}
              >
                {state.status === "active" ? "緊急停止" : "再開"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={reset}>
                リセット
              </button>
            </div>

            <div className="log" aria-live="polite">
              {logs.map((l) => (
                <div
                  key={l.id}
                  className={
                    l.kind === "ok"
                      ? "log__line log__line--ok"
                      : l.kind === "bad"
                        ? "log__line log__line--bad"
                        : "log__line"
                  }
                >
                  {l.text}
                </div>
              ))}
            </div>

            {executed.length > 0 && (
              <RecentGrants proposals={executed.slice(-8).reverse()} />
            )}
          </div>

          <aside className="school-panel">
            <h3>
              対象高専 ({schools.length})
              <span className="tag" style={{ marginLeft: "0.5rem" }}>
                {region}
              </span>
            </h3>
            <ul className="school-list">
              {schools.map((s) => (
                <li key={s.id}>
                  <div>
                    <div>{s.shortName}</div>
                    <div className="school-list__meta">
                      {s.prefecture} · {s.strengths.slice(0, 3).join(" / ")}
                    </div>
                  </div>
                  <span className="tag">{s.type}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>

      <section className="safety" id="safety">
        <div className="section__head">
          <h2>安全策は後付けではない</h2>
          <p>完全な無人運用ではなく、ポリシー境界内の自律です。</p>
        </div>
        <ul className="safety__list">
          <li>
            <strong>準備金フロア</strong> — 元本の一定割合を常時ロック
          </li>
          <li>
            <strong>単筆・月次上限</strong> — 一度に基金を使い切れない
          </li>
          <li>
            <strong>マンデート外却下</strong> — 高専以外・未許可カテゴリは自動拒否
          </li>
          <li>
            <strong>緊急停止</strong> — 人間がいつでも pause できる
          </li>
          <li>
            <strong>公開台帳</strong> — すべての意思決定と送金を記録
          </li>
        </ul>
      </section>

      <footer className="footer">
        <div>
          <strong>FundOS</strong> · 高専拠出 MVP
        </div>
        <div>オフチェーン・デモ。実送金・法務・税務は別途設計が必要です。</div>
      </footer>
    </div>
  );
}

function RecentGrants({ proposals }: { proposals: DisbursementProposal[] }) {
  return (
    <div style={{ marginTop: "1.25rem" }}>
      <h3
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "0.95rem",
          margin: "0 0 0.6rem",
        }}
      >
        直近の実行
      </h3>
      <ul className="school-list">
        {proposals.map((p) => (
          <li key={p.id}>
            <div>
              <div>{p.recipientName}</div>
              <div className="school-list__meta">{p.rationale}</div>
            </div>
            <span className="tag">{formatUnits(p.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
