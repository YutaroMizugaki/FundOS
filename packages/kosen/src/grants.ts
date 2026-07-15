import {
  FundVault,
  parseUnits,
  type Amount,
  type Mandate,
  type Pitch,
  type SettleResult,
} from "@fundos/core";
import {
  getKosen,
  listKosen,
  type KosenRegion,
  type KosenSchool,
} from "./registry.js";

/** Grant categories allowed for the KOSEN pitch fund. */
export const KOSEN_GRANT_CATEGORIES = [
  "equipment",
  "scholarship",
  "research",
  "competition",
] as const;

export type KosenGrantCategory = (typeof KOSEN_GRANT_CATEGORIES)[number];

export const KOSEN_MANDATE: Mandate = {
  purpose:
    "高専の学生がプレゼンしたプロジェクトに対し、拠出者の投票で支援を配分する",
  allowedCategories: [...KOSEN_GRANT_CATEGORIES],
  scope: "日本の高等専門学校の学生プロジェクト",
};

export interface KosenFundOptions {
  name?: string;
  /** Optional seed (usually 0 — capital comes from contributors). */
  initialDeposit?: Amount;
  reserveFloorRatio?: number;
  maxDisbursementRatio?: number;
  monthlySpendCapRatio?: number;
}

export interface StudentPitchInput {
  studentName: string;
  kosenId: string;
  title: string;
  abstract: string;
  category: KosenGrantCategory;
  requestedAmount: Amount;
  roundId?: string;
}

/**
 * Create an empty (or seeded) KOSEN pitch-vote fund.
 */
export function createKosenFund(options: KosenFundOptions = {}): FundVault {
  return FundVault.create({
    name: options.name ?? "FundOS 高専ピッチ基金",
    mandate: KOSEN_MANDATE,
    initialDeposit: options.initialDeposit ?? 0n,
    reserveFloorRatio: options.reserveFloorRatio ?? 0.2,
    maxDisbursementRatio: options.maxDisbursementRatio ?? 0.25,
    monthlySpendCapRatio: options.monthlySpendCapRatio ?? 0.6,
  });
}

export function submitStudentPitch(
  fund: FundVault,
  input: StudentPitchInput,
): Pitch {
  const school = getKosen(input.kosenId);
  if (!school) throw new Error(`Unknown kosen id: ${input.kosenId}`);

  let roundId = input.roundId;
  if (!roundId) {
    const current = fund.currentRound();
    if (!current || current.status !== "pitching") {
      throw new Error("No open pitching round — call openPitchRound first");
    }
    roundId = current.id;
  }

  return fund.submitPitch({
    roundId,
    studentName: input.studentName,
    schoolId: school.id,
    schoolName: school.name,
    title: input.title,
    abstract: input.abstract,
    category: input.category,
    requestedAmount: input.requestedAmount,
  });
}

export function openPitchRound(
  fund: FundVault,
  title: string,
  opts?: { budgetRatio?: number; budget?: Amount },
) {
  return fund.openRound({
    title,
    budgetRatio: opts?.budgetRatio ?? 0.5,
    budget: opts?.budget,
  });
}

/** Demo helper: seed contributors + student pitches. */
export function seedDemoArena(
  fund: FundVault,
  opts: {
    roundTitle?: string;
    region?: KosenRegion;
    schools?: KosenSchool[];
  } = {},
): {
  contributors: ReturnType<FundVault["contribute"]>[];
  pitches: Pitch[];
  roundId: string;
} {
  const contributors = [
    fund.contribute({ name: "みずがき", amount: parseUnits("300000") }),
    fund.contribute({ name: "卒業生A", amount: parseUnits("150000") }),
    fund.contribute({ name: "地域企業B", amount: parseUnits("200000") }),
  ];

  const round = openPitchRound(fund, opts.roundTitle ?? "デモ・ピッチラウンド", {
    budgetRatio: 0.55,
  });

  const schools =
    opts.schools ??
    (opts.region ? listKosen({ region: opts.region }) : listKosen()).slice(
      0,
      4,
    );

  const templates: Array<{
    studentName: string;
    title: string;
    abstract: string;
    category: KosenGrantCategory;
    requestedAmount: Amount;
  }> = [
    {
      studentName: "田中 遥",
      title: "湖沼モニタリング用水中ドローン",
      abstract:
        "安価なセンサとオープンハードで、地域の水質を継続観測するプロトタイプを作ります。",
      category: "research",
      requestedAmount: parseUnits("70000"),
    },
    {
      studentName: "伊藤 蓮",
      title: "ロボコン用軽量駆動モジュール",
      abstract:
        "高専ロボコン向けに、保守しやすいモジュール型駆動系を設計・製作します。",
      category: "competition",
      requestedAmount: parseUnits("55000"),
    },
    {
      studentName: "中村 葵",
      title: "高専生向け学習コミュニティ奨学金",
      abstract:
        "地方高専のオンライン勉強会運営と、教材印刷・会場費の奨学金として使います。",
      category: "scholarship",
      requestedAmount: parseUnits("40000"),
    },
    {
      studentName: "山本 樹",
      title: "実験室の安全IoTキット",
      abstract:
        "ガス・温度・人感をまとめて見える化する実験室向けIoTキットを試作します。",
      category: "equipment",
      requestedAmount: parseUnits("48000"),
    },
  ];

  const count = Math.min(templates.length, Math.max(2, schools.length));
  const pitches: Pitch[] = [];
  for (let i = 0; i < count; i++) {
    const t = templates[i]!;
    const school = schools[i % schools.length]!;
    pitches.push(
      submitStudentPitch(fund, {
        ...t,
        kosenId: school.id,
        roundId: round.id,
      }),
    );
  }

  return { contributors, pitches, roundId: round.id };
}

export function runVoteAndSettle(
  fund: FundVault,
  roundId: string,
  ballots: Array<{
    contributorId: string;
    allocations: Array<{ pitchId: string; weight: Amount }>;
  }>,
): SettleResult {
  fund.openVoting(roundId);
  for (const b of ballots) {
    fund.castVote(roundId, b.contributorId, b.allocations);
  }
  return fund.settle(roundId);
}
