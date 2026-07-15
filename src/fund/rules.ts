import { MS_PER_YEAR } from "../clock.js";
import type { AccountId, Bps } from "../money/types.js";
import { abs, applyBps } from "../util/money.js";
import type { Rule, RuleContext } from "./engine.js";

/**
 * Sweep everything sitting in a source bucket (typically "intake") into a
 * working bucket so freshly contributed capital is put to work rather than
 * lying idle.
 */
export class SweepRule implements Rule {
  readonly name: string;

  constructor(
    private readonly from: string,
    private readonly to: string,
    /** Don't bother sweeping dust below this threshold. */
    private readonly minAmount: bigint = 1n,
  ) {
    this.name = `sweep:${from}->${to}`;
  }

  evaluate(ctx: RuleContext): void {
    const balance = ctx.fund.bucketBalance(this.from);
    if (balance < this.minAmount) return;
    ctx.fund.moveBetweenBuckets(this.from, this.to, balance, "sweep");
    ctx.log("rule.sweep", `swept ${balance} from ${this.from} to ${this.to}`, {
      amount: balance.toString(),
      from: this.from,
      to: this.to,
    });
  }
}

export interface TargetAllocationConfig {
  /** Target weights per bucket, in basis points. Must sum to 10000. */
  weights: Record<string, Bps>;
  /**
   * Only rebalance once any bucket drifts more than this many bps away from
   * its target, to avoid churning on every tick.
   */
  driftBps: Bps;
}

/**
 * Keep the fund's investable buckets at their target weights. Computes the
 * ideal balance for each weighted bucket and moves value from over-weight
 * buckets into under-weight ones, but only when drift exceeds the threshold.
 */
export class TargetAllocationRule implements Rule {
  readonly name = "target-allocation";
  private readonly weights: Array<[string, Bps]>;
  private readonly driftBps: Bps;

  constructor(config: TargetAllocationConfig) {
    this.weights = Object.entries(config.weights);
    const total = this.weights.reduce((s, [, w]) => s + w, 0n);
    if (total !== 10_000n) {
      throw new Error(`allocation weights must sum to 10000 bps, got ${total}`);
    }
    this.driftBps = config.driftBps;
  }

  evaluate(ctx: RuleContext): void {
    const base = this.weights.reduce((s, [name]) => s + ctx.fund.bucketBalance(name), 0n);
    if (base === 0n) return;

    const targets = new Map<string, bigint>();
    for (const [name, weight] of this.weights) targets.set(name, applyBps(base, weight));

    // Detect whether anything drifts beyond the threshold.
    let maxDrift = 0n;
    for (const [name] of this.weights) {
      const current = ctx.fund.bucketBalance(name);
      const target = targets.get(name)!;
      const driftBps = (abs(current - target) * 10_000n) / base;
      if (driftBps > maxDrift) maxDrift = driftBps;
    }
    if (maxDrift < this.driftBps) return;

    // Build lists of surpluses and deficits, then match them up.
    const surplus: Array<{ name: string; amount: bigint }> = [];
    const deficit: Array<{ name: string; amount: bigint }> = [];
    for (const [name] of this.weights) {
      const delta = ctx.fund.bucketBalance(name) - targets.get(name)!;
      if (delta > 0n) surplus.push({ name, amount: delta });
      else if (delta < 0n) deficit.push({ name, amount: -delta });
    }

    let s = 0;
    for (const need of deficit) {
      let remaining = need.amount;
      while (remaining > 0n && s < surplus.length) {
        const src = surplus[s]!;
        const move = remaining < src.amount ? remaining : src.amount;
        ctx.fund.moveBetweenBuckets(src.name, need.name, move, "rebalance");
        src.amount -= move;
        remaining -= move;
        if (src.amount === 0n) s += 1;
      }
    }

    ctx.log("rule.rebalanced", `rebalanced to target weights (drift ${maxDrift}bps)`, {
      driftBps: maxDrift.toString(),
    });
  }
}

export interface YieldConfig {
  bucket: string;
  /** Annualised return in basis points (e.g. 500 == 5%/yr). May be negative. */
  annualBps: Bps;
}

/**
 * Accrue (or decay) simulated investment returns on a bucket. The accrual is
 * proportional to real elapsed time, so it is correct regardless of how often
 * the engine ticks.
 */
export class YieldRule implements Rule {
  readonly name: string;
  private lastAccruedAt: number | null = null;

  constructor(private readonly config: YieldConfig) {
    this.name = `yield:${config.bucket}`;
  }

  evaluate(ctx: RuleContext): void {
    if (this.lastAccruedAt === null) {
      this.lastAccruedAt = ctx.now;
      return;
    }
    const elapsed = ctx.now - this.lastAccruedAt;
    if (elapsed <= 0) return;
    this.lastAccruedAt = ctx.now;

    const balance = ctx.fund.bucketBalance(this.config.bucket);
    if (balance === 0n) return;

    // periodBps = annualBps * elapsed / year
    const periodBps = (this.config.annualBps * BigInt(elapsed)) / BigInt(MS_PER_YEAR);
    if (periodBps === 0n) return;

    const gross = balance * periodBps;
    const delta = gross / 10_000n; // signed; bigint division truncates toward zero
    if (delta === 0n) return;

    ctx.fund.applyReturn(this.config.bucket, delta, "yield");
    ctx.log("rule.yield", `accrued ${delta} on ${this.config.bucket}`, {
      bucket: this.config.bucket,
      delta: delta.toString(),
      periodBps: periodBps.toString(),
    });
  }
}

export interface Beneficiary {
  account: AccountId;
  /** Share of each distribution, in basis points. */
  weightBps: Bps;
  /** Optional earmark purpose attached to the disbursement. */
  purpose?: string;
}

export interface SpendingConfig {
  /** Bucket distributions are paid out of (e.g. "reserve"). */
  sourceBucket: string;
  /** How often to distribute, in ms. */
  periodMs: number;
  /**
   * Annualised spend rate in bps applied to the asset base each period
   * (endowment-style, e.g. 400 == the classic 4% rule).
   */
  annualSpendBps: Bps;
  beneficiaries: Beneficiary[];
  /**
   * When true (default) the spend base is total AUM; the payout is still
   * capped by the liquid source bucket so principal is preserved.
   */
  spendFromTotalAssets?: boolean;
}

/**
 * Endowment-style spending policy. Every `periodMs`, distribute an
 * annualised fraction of the asset base to beneficiaries — but only up to what
 * the source bucket can cover, preserving invested principal. Honours the
 * engine's global distribution pause (circuit breaker).
 */
export class SpendingRule implements Rule {
  readonly name = "spending-policy";
  private nextPayoutAt: number | null = null;
  private readonly totalWeight: bigint;

  constructor(private readonly config: SpendingConfig) {
    if (config.periodMs <= 0) throw new Error("periodMs must be > 0");
    this.totalWeight = config.beneficiaries.reduce((s, b) => s + b.weightBps, 0n);
    if (this.totalWeight <= 0n) throw new Error("beneficiary weights must sum to > 0");
  }

  evaluate(ctx: RuleContext): void {
    if (this.nextPayoutAt === null) {
      this.nextPayoutAt = ctx.now + this.config.periodMs;
      return;
    }
    if (ctx.now < this.nextPayoutAt) return;
    this.nextPayoutAt += this.config.periodMs;

    if (ctx.engine.distributionsPaused) {
      ctx.log("rule.spending.skipped", "distribution skipped (paused)", {
        reason: ctx.engine.pauseReason,
      });
      return;
    }

    const base =
      this.config.spendFromTotalAssets === false
        ? ctx.fund.bucketBalance(this.config.sourceBucket)
        : ctx.fund.totalAssets();

    // Annualised rate pro-rated to this period.
    const periodBps = (this.config.annualSpendBps * BigInt(this.config.periodMs)) / BigInt(MS_PER_YEAR);
    let payout = applyBps(base, periodBps);

    const available = ctx.fund.bucketBalance(this.config.sourceBucket);
    if (payout > available) payout = available;
    if (payout === 0n) {
      ctx.log("rule.spending.skipped", "nothing to distribute", {});
      return;
    }

    let distributed = 0n;
    for (const b of this.config.beneficiaries) {
      const share = (payout * b.weightBps) / this.totalWeight;
      if (share === 0n) continue;
      ctx.fund.disburse(this.config.sourceBucket, b.account, share, b.purpose);
      distributed += share;
    }

    ctx.log("rule.spending", `distributed ${distributed} to beneficiaries`, {
      total: distributed.toString(),
      base: base.toString(),
      periodBps: periodBps.toString(),
    });
  }
}

export interface ReserveFloorConfig {
  /** Bucket whose balance is monitored. */
  watchBucket: string;
  /** If the bucket drops below this, pause distributions. */
  floor: bigint;
  /** Resume once the bucket recovers above this (defaults to `floor`). */
  resumeAbove?: bigint;
}

/**
 * Circuit breaker: pauses all distributions when a reserve bucket falls below a
 * floor, and resumes once it recovers. Protects the fund from being drained in
 * a downturn without any human intervention.
 */
export class ReserveFloorGuard implements Rule {
  readonly name = "reserve-floor-guard";
  private readonly resumeAbove: bigint;

  constructor(private readonly config: ReserveFloorConfig) {
    this.resumeAbove = config.resumeAbove ?? config.floor;
  }

  evaluate(ctx: RuleContext): void {
    const balance = ctx.fund.bucketBalance(this.config.watchBucket);
    if (balance < this.config.floor) {
      ctx.engine.pauseDistributions(
        `${this.config.watchBucket} ${balance} below floor ${this.config.floor}`,
      );
    } else if (ctx.engine.distributionsPaused && balance >= this.resumeAbove) {
      ctx.engine.resumeDistributions(
        `${this.config.watchBucket} ${balance} recovered above ${this.resumeAbove}`,
      );
    }
  }
}
