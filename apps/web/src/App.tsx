import { useMemo, useState, type ReactNode } from "react";
import {
  formatUnits,
  parseUnits,
  type Contributor,
  type Pitch,
} from "@fundos/core";
import {
  createKosenFund,
  listKosen,
  openPitchRound,
  seedDemoArena,
  submitStudentPitch,
  type KosenGrantCategory,
} from "@fundos/kosen";

type LogKind = "info" | "ok" | "bad";

interface LogLine {
  id: string;
  kind: LogKind;
  text: string;
}

const CATEGORIES: KosenGrantCategory[] = [
  "research",
  "competition",
  "equipment",
  "scholarship",
];

function bootFund() {
  return createKosenFund();
}

export function App() {
  const [fund, setFund] = useState(bootFund);
  const [, bump] = useState(0);
  const refresh = () => {
    setFund(fund);
    bump((n) => n + 1);
  };

  const [logs, setLogs] = useState<LogLine[]>([
    {
      id: "boot",
      kind: "info",
      text: "拠出者が投票権を持ち、学生プレゼンに配分するデモです",
    },
  ]);

  const [ctrbName, setCtrbName] = useState("あなた");
  const [ctrbAmount, setCtrbAmount] = useState("100000");

  const [studentName, setStudentName] = useState("田中 遥");
  const [kosenId, setKosenId] = useState("kosen_tokyo");
  const [pitchTitle, setPitchTitle] = useState("湖沼モニタリング用水中ドローン");
  const [pitchAbstract, setPitchAbstract] = useState(
    "安価なセンサで地域の水質を継続観測するプロトタイプを作ります。",
  );
  const [pitchCategory, setPitchCategory] =
    useState<KosenGrantCategory>("research");
  const [pitchAsk, setPitchAsk] = useState("70000");

  const [voterId, setVoterId] = useState("");
  const [votePitchId, setVotePitchId] = useState("");
  const [voteWeight, setVoteWeight] = useState("");

  const state = fund.getState();
  const summary = fund.summary();
  const round = state.rounds.find((r) => r.status !== "settled");
  const pitches = round
    ? state.pitches.filter((p) => p.roundId === round.id)
    : [];
  const settledPitches = state.pitches.filter((p) =>
    ["funded", "partial", "unfunded"].includes(p.status),
  );
  const schools = useMemo(() => listKosen(), []);

  const pushLog = (kind: LogKind, text: string) => {
    setLogs((prev) =>
      [
        { id: `${Date.now()}_${Math.random()}`, kind, text },
        ...prev,
      ].slice(0, 50),
    );
  };

  const onContribute = () => {
    try {
      const c = fund.contribute({
        name: ctrbName.trim() || "匿名拠出者",
        amount: parseUnits(ctrbAmount),
      });
      pushLog(
        "ok",
        `${c.name} が拠出 → 投票権 ${formatUnits(c.votingPower)}`,
      );
      if (!voterId) setVoterId(c.id);
      refresh();
    } catch (e) {
      pushLog("bad", (e as Error).message);
    }
  };

  const onOpenRound = () => {
    try {
      const r = openPitchRound(fund, "ライブ・ピッチラウンド", {
        budgetRatio: 0.55,
      });
      pushLog(
        "ok",
        `ラウンド開始「${r.title}」予算 ${formatUnits(r.budget)}`,
      );
      refresh();
    } catch (e) {
      pushLog("bad", (e as Error).message);
    }
  };

  const onSubmitPitch = () => {
    try {
      const p = submitStudentPitch(fund, {
        studentName: studentName.trim(),
        kosenId,
        title: pitchTitle.trim(),
        abstract: pitchAbstract.trim(),
        category: pitchCategory,
        requestedAmount: parseUnits(pitchAsk),
      });
      pushLog("ok", `ピッチ提出: ${p.studentName}「${p.title}」`);
      if (!votePitchId) setVotePitchId(p.id);
      refresh();
    } catch (e) {
      pushLog("bad", (e as Error).message);
    }
  };

  const onOpenVoting = () => {
    if (!round) return;
    try {
      fund.openVoting(round.id);
      pushLog("ok", "投票を開始しました");
      refresh();
    } catch (e) {
      pushLog("bad", (e as Error).message);
    }
  };

  const onCastVote = () => {
    if (!round) return;
    try {
      const contributor =
        state.contributors.find((c) => c.id === voterId) ??
        state.contributors[0];
      if (!contributor) throw new Error("先に拠出してください");
      const pitch = pitches.find((p) => p.id === votePitchId) ?? pitches[0];
      if (!pitch) throw new Error("ピッチがありません");
      const weight = voteWeight
        ? parseUnits(voteWeight)
        : contributor.votingPower;
      fund.castVote(round.id, contributor.id, [
        { pitchId: pitch.id, weight },
      ]);
      pushLog(
        "ok",
        `${contributor.name} →「${pitch.title}」に ${formatUnits(weight)} 票`,
      );
      setVoterId(contributor.id);
      setVotePitchId(pitch.id);
      refresh();
    } catch (e) {
      pushLog("bad", (e as Error).message);
    }
  };

  const onSettle = () => {
    if (!round) return;
    try {
      const result = fund.settle(round.id);
      for (const p of result.pitches) {
        pushLog(
          p.fundedAmount > 0n ? "ok" : "info",
          `${p.studentName}「${p.title}」票 ${formatUnits(p.votesReceived)} → 配分 ${formatUnits(p.fundedAmount)}`,
        );
      }
      pushLog("info", `ラウンド確定（執行 ${result.executed.length} 件）`);
      refresh();
    } catch (e) {
      pushLog("bad", (e as Error).message);
    }
  };

  const onSeedDemo = () => {
    try {
      const fresh = bootFund();
      const seeded = seedDemoArena(fresh, { region: "東海" });
      setFund(fresh);
      setVoterId(seeded.contributors[0]?.id ?? "");
      setVotePitchId(seeded.pitches[0]?.id ?? "");
      setLogs([
        {
          id: "seed",
          kind: "ok",
          text: `デモ投入: 拠出者 ${seeded.contributors.length} / ピッチ ${seeded.pitches.length}`,
        },
      ]);
      bump((n) => n + 1);
    } catch (e) {
      pushLog("bad", (e as Error).message);
    }
  };

  const onReset = () => {
    setFund(bootFund());
    setVoterId("");
    setVotePitchId("");
    setLogs([{ id: "reset", kind: "info", text: "基金をリセットしました" }]);
    bump((n) => n + 1);
  };

  const onPause = () => {
    if (state.status === "active") {
      fund.pause();
      pushLog("bad", "緊急停止");
    } else if (state.status === "paused") {
      fund.resume();
      pushLog("ok", "再開");
    }
    refresh();
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
            <a href="#flow">流れ</a>
            <a href="#live">ライブ</a>
            <a href="#safety">ルール</a>
          </div>
        </nav>
        <div className="hero__content">
          <h1 className="hero__brand">
            Fund<em>OS</em>
          </h1>
          <p className="hero__subbrand">高専ピッチ基金</p>
          <p className="hero__lede">
            拠出者が投票権を持ち、高専生のプレゼンに票を入れる。票の重みで支援金が按分される、プログラマブルな寄付の場。
          </p>
          <div className="cta-row">
            <a className="btn btn--primary" href="#live">
              投票デモを開く
            </a>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onSeedDemo}
            >
              サンプルを入れる
            </button>
          </div>
        </div>
      </header>

      <section className="how" id="flow">
        <div className="section__head">
          <h2>拠出 → プレゼン → 投票 → 配分</h2>
          <p>お金を出す人が議決権を持ち、学生の発表が提案になる。</p>
        </div>
        <div className="flow">
          <article className="flow__item">
            <h3>拠出 = 投票権</h3>
            <p>1 の拠出で 1 の投票権。追加拠出で票も増える。</p>
          </article>
          <article className="flow__item">
            <h3>学生がプレゼン</h3>
            <p>所属高専・要旨・希望額をピッチとして提出する。</p>
          </article>
          <article className="flow__item">
            <h3>投票で按分</h3>
            <p>票の比率でラウンド予算を配分。上限・準備金はポリシーで保護。</p>
          </article>
        </div>
      </section>

      <section className="console" id="live">
        <div className="section__head">
          <h2>ライブ・アリーナ</h2>
          <p>
            ラウンド状態:{" "}
            <strong>
              {round ? `${round.title}（${round.status}）` : "なし"}
            </strong>
          </p>
        </div>

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
            <span className="metric__label">Voting Power</span>
            <span className="metric__value metric__value--accent">
              {summary.totalVotingPower}
            </span>
          </div>
          <div className="metric">
            <span className="metric__label">Contributors</span>
            <span className="metric__value metric__value--brass">
              {summary.contributors}
            </span>
          </div>
        </div>

        <div className="arena-grid">
          <Panel title="1. 拠出する">
            <Field label="名前">
              <input
                value={ctrbName}
                onChange={(e) => setCtrbName(e.target.value)}
              />
            </Field>
            <Field label="金額">
              <input
                value={ctrbAmount}
                onChange={(e) => setCtrbAmount(e.target.value)}
              />
            </Field>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onContribute}
            >
              拠出して投票権を得る
            </button>
            <ContributorList contributors={state.contributors} />
          </Panel>

          <Panel title="2. 学生ピッチ">
            {!round && (
              <button
                type="button"
                className="btn btn--brass"
                onClick={onOpenRound}
              >
                ラウンドを開く
              </button>
            )}
            {round?.status === "pitching" && (
              <>
                <Field label="学生名">
                  <input
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                  />
                </Field>
                <Field label="高専">
                  <select
                    value={kosenId}
                    onChange={(e) => setKosenId(e.target.value)}
                  >
                    {schools.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.shortName}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="タイトル">
                  <input
                    value={pitchTitle}
                    onChange={(e) => setPitchTitle(e.target.value)}
                  />
                </Field>
                <Field label="プレゼン要旨">
                  <textarea
                    rows={3}
                    value={pitchAbstract}
                    onChange={(e) => setPitchAbstract(e.target.value)}
                  />
                </Field>
                <Field label="カテゴリ">
                  <select
                    value={pitchCategory}
                    onChange={(e) =>
                      setPitchCategory(e.target.value as KosenGrantCategory)
                    }
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="希望額">
                  <input
                    value={pitchAsk}
                    onChange={(e) => setPitchAsk(e.target.value)}
                  />
                </Field>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onSubmitPitch}
                >
                  ピッチを提出
                </button>
              </>
            )}
            {round?.status === "pitching" && pitches.length > 0 && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onOpenVoting}
                style={{ marginTop: "0.5rem" }}
              >
                投票フェーズへ
              </button>
            )}
            <PitchList
              pitches={pitches.length ? pitches : settledPitches.slice(-6)}
            />
          </Panel>

          <Panel title="3. 投票・確定">
            {round?.status === "voting" ? (
              <>
                <Field label="拠出者">
                  <select
                    value={voterId}
                    onChange={(e) => setVoterId(e.target.value)}
                  >
                    {state.contributors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}（権 {formatUnits(c.votingPower)}）
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="ピッチ">
                  <select
                    value={votePitchId}
                    onChange={(e) => setVotePitchId(e.target.value)}
                  >
                    {pitches.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.studentName} — {p.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="票数（空欄=全投票権）">
                  <input
                    value={voteWeight}
                    onChange={(e) => setVoteWeight(e.target.value)}
                    placeholder="全額"
                  />
                </Field>
                <div className="cta-row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={onCastVote}
                  >
                    投票する
                  </button>
                  <button
                    type="button"
                    className="btn btn--brass"
                    onClick={onSettle}
                  >
                    ラウンド確定
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">
                {round
                  ? "ピッチ受付中です。揃ったら投票フェーズへ。"
                  : "ラウンドを開くか、サンプルを入れてください。"}
              </p>
            )}
            <div className="cta-row" style={{ marginTop: "0.75rem" }}>
              <button type="button" className="btn btn--ghost" onClick={onPause}>
                {state.status === "active" ? "緊急停止" : "再開"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={onReset}>
                リセット
              </button>
            </div>
          </Panel>
        </div>

        <div className="log" aria-live="polite" style={{ marginTop: "1.25rem" }}>
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
      </section>

      <section className="safety" id="safety">
        <div className="section__head">
          <h2>埋め込まれたルール</h2>
          <p>投票結果も、ポリシーを超えれば執行されない。</p>
        </div>
        <ul className="safety__list">
          <li>
            <strong>投票権 = 拠出額</strong> — 持っている票以上は入れられない
          </li>
          <li>
            <strong>按分 + 希望額キャップ</strong> — 票が多くても申請額まで
          </li>
          <li>
            <strong>マンデート</strong> — 高専学生の許可カテゴリ以外は提出不可
          </li>
          <li>
            <strong>準備金・月次上限</strong> — 基金を守りながら配分
          </li>
          <li>
            <strong>緊急停止</strong> — 人間がいつでも pause
          </li>
        </ul>
      </section>

      <footer className="footer">
        <div>
          <strong>FundOS</strong> · 高専ピッチ投票 MVP
        </div>
        <div>オフチェーン・デモ。実送金・法務は別途。</div>
      </footer>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ContributorList({ contributors }: { contributors: Contributor[] }) {
  if (contributors.length === 0) {
    return <p className="muted">まだ拠出者はいません</p>;
  }
  return (
    <ul className="school-list">
      {contributors.map((c) => (
        <li key={c.id}>
          <div>
            <div>{c.name}</div>
            <div className="school-list__meta">
              拠出 {formatUnits(c.contributed)}
            </div>
          </div>
          <span className="tag">VP {formatUnits(c.votingPower)}</span>
        </li>
      ))}
    </ul>
  );
}

function PitchList({ pitches }: { pitches: Pitch[] }) {
  if (pitches.length === 0) {
    return <p className="muted">ピッチはまだありません</p>;
  }
  return (
    <ul className="school-list">
      {pitches.map((p) => (
        <li key={p.id}>
          <div>
            <div>
              {p.studentName}「{p.title}」
            </div>
            <div className="school-list__meta">
              {p.schoolName} · 希望 {formatUnits(p.requestedAmount)} · 票{" "}
              {formatUnits(p.votesReceived)}
              {p.fundedAmount > 0n
                ? ` · 配分 ${formatUnits(p.fundedAmount)}`
                : ""}
            </div>
          </div>
          <span className="tag">{p.status}</span>
        </li>
      ))}
    </ul>
  );
}
