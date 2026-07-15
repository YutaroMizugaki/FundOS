import type { Clock } from "../clock.js";
import type { EventLog } from "../events.js";
import { Ledger } from "../money/ledger.js";
import type { AccountId } from "../money/types.js";
import { assertNonNegative } from "../util/money.js";

export interface BucketConfig {
  name: string;
  label?: string;
}

export interface FundConfig {
  name: string;
  ledger: Ledger;
  clock: Clock;
  /**
   * Named treasury buckets the fund allocates across, e.g.
   * `["intake", "principal", "growth", "reserve"]`.
   */
  buckets: BucketConfig[];
  /** Bucket that incoming contributions land in. Must be one of `buckets`. */
  intakeBucket: string;
  /** Bucket redemptions are paid out of. Defaults to the intake bucket. */
  liquidBucket?: string;
}

export interface ContributionResult {
  investor: AccountId;
  amountIn: bigint;
  sharesMinted: bigint;
  navBefore: bigint;
}

export interface RedemptionResult {
  investor: AccountId;
  sharesBurned: bigint;
  amountOut: bigint;
}

/** Fixed-point precision used for NAV-per-share calculations. */
const NAV_PRECISION = 1_000_000n;

/**
 * A pooled fund built on top of the programmable-money ledger.
 *
 * Contributors deposit money and receive shares valued at the current net
 * asset value (NAV). The fund's assets live in named treasury buckets that the
 * autonomous rule engine moves value between (allocation, yield, spending).
 */
export class Fund {
  readonly name: string;
  readonly ledger: Ledger;
  readonly clock: Clock;
  readonly events: EventLog;

  private readonly buckets = new Map<string, AccountId>();
  private readonly intakeBucket: string;
  private readonly liquidBucketName: string;

  private readonly shares = new Map<AccountId, bigint>();
  private totalShares = 0n;

  constructor(config: FundConfig) {
    this.name = config.name;
    this.ledger = config.ledger;
    this.clock = config.clock;
    this.events = config.ledger.events;

    for (const bucket of config.buckets) {
      const account = this.ledger.open({
        label: `${config.name}:${bucket.label ?? bucket.name}`,
        metadata: { fund: config.name, bucket: bucket.name },
      });
      this.buckets.set(bucket.name, account.id);
    }

    if (!this.buckets.has(config.intakeBucket)) {
      throw new Error(`intakeBucket "${config.intakeBucket}" is not a declared bucket`);
    }
    this.intakeBucket = config.intakeBucket;
    this.liquidBucketName = config.liquidBucket ?? config.intakeBucket;
    if (!this.buckets.has(this.liquidBucketName)) {
      throw new Error(`liquidBucket "${this.liquidBucketName}" is not a declared bucket`);
    }
  }

  /** Resolve a bucket name to its ledger account id. */
  bucketId(name: string): AccountId {
    const id = this.buckets.get(name);
    if (!id) throw new Error(`unknown bucket "${name}" in fund ${this.name}`);
    return id;
  }

  bucketNames(): string[] {
    return [...this.buckets.keys()];
  }

  bucketBalance(name: string): bigint {
    return this.ledger.balanceOf(this.bucketId(name));
  }

  /** Total assets under management across every bucket. */
  totalAssets(): bigint {
    let total = 0n;
    for (const id of this.buckets.values()) total += this.ledger.balanceOf(id);
    return total;
  }

  get shareSupply(): bigint {
    return this.totalShares;
  }

  sharesOf(investor: AccountId): bigint {
    return this.shares.get(investor) ?? 0n;
  }

  /**
   * NAV per share, scaled by {@link NAV_PRECISION}. When no shares exist yet
   * the NAV is defined as exactly 1.0 so the first contribution mints shares
   * 1:1 with the deposited amount.
   */
  navPerShare(): bigint {
    if (this.totalShares === 0n) return NAV_PRECISION;
    return (this.totalAssets() * NAV_PRECISION) / this.totalShares;
  }

  /**
   * Deposit money from `investor` (an external ledger account) into the fund's
   * intake bucket, minting shares at the current NAV.
   */
  contribute(investor: AccountId, amount: bigint, memo?: string): ContributionResult {
    assertNonNegative(amount, "contribution amount");
    if (amount === 0n) throw new Error("contribution must be positive");

    const navBefore = this.navPerShare();
    const sharesMinted =
      this.totalShares === 0n ? amount : (amount * this.totalShares) / this.totalAssets();
    if (sharesMinted === 0n) {
      throw new Error("contribution too small to mint any shares at current NAV");
    }

    this.ledger.transfer(investor, this.bucketId(this.intakeBucket), amount, {
      memo: memo ?? "contribution",
      tags: { kind: "contribution", fund: this.name },
    });

    this.shares.set(investor, this.sharesOf(investor) + sharesMinted);
    this.totalShares += sharesMinted;

    this.events.emit(this.clock.now(), "fund.contributed", `${investor} contributed to ${this.name}`, {
      investor,
      amount: amount.toString(),
      shares: sharesMinted.toString(),
      navBefore: navBefore.toString(),
    });

    return { investor, amountIn: amount, sharesMinted, navBefore };
  }

  /**
   * Redeem `shares` for their current NAV value, paid out of the liquid
   * bucket. Throws if the liquid bucket cannot cover the redemption.
   */
  redeem(investor: AccountId, shares: bigint, memo?: string): RedemptionResult {
    assertNonNegative(shares, "redeem shares");
    if (shares === 0n) throw new Error("redemption must be positive");
    const held = this.sharesOf(investor);
    if (shares > held) throw new Error(`investor holds ${held} shares, cannot redeem ${shares}`);

    const amountOut = (shares * this.totalAssets()) / this.totalShares;
    const liquidId = this.bucketId(this.liquidBucketName);
    if (this.ledger.balanceOf(liquidId) < amountOut) {
      throw new Error(
        `insufficient liquidity: ${this.liquidBucketName} holds ` +
          `${this.ledger.balanceOf(liquidId)}, redemption needs ${amountOut}`,
      );
    }

    this.ledger.transfer(liquidId, investor, amountOut, {
      memo: memo ?? "redemption",
      tags: { kind: "redemption", fund: this.name },
    });

    this.shares.set(investor, held - shares);
    this.totalShares -= shares;

    this.events.emit(this.clock.now(), "fund.redeemed", `${investor} redeemed from ${this.name}`, {
      investor,
      shares: shares.toString(),
      amount: amountOut.toString(),
    });

    return { investor, sharesBurned: shares, amountOut };
  }

  /** Move value between two buckets (used by the autonomous rule engine). */
  moveBetweenBuckets(from: string, to: string, amount: bigint, memo?: string): void {
    if (amount === 0n) return;
    assertNonNegative(amount, "move amount");
    this.ledger.transfer(this.bucketId(from), this.bucketId(to), amount, {
      memo: memo ?? `rebalance ${from}->${to}`,
      tags: { kind: "internal", fund: this.name, from, to },
    });
  }

  /**
   * Credit simulated investment returns into a bucket (mints new units to
   * represent gains) or debit a loss (burns units).
   */
  applyReturn(bucket: string, delta: bigint, memo?: string): void {
    const id = this.bucketId(bucket);
    if (delta > 0n) {
      this.ledger.mint(id, delta, memo ?? "yield");
    } else if (delta < 0n) {
      const loss = -delta;
      const cap = this.ledger.balanceOf(id);
      this.ledger.burn(id, loss > cap ? cap : loss, memo ?? "loss");
    }
  }

  /** Pay value out of a bucket to an external beneficiary account. */
  disburse(fromBucket: string, beneficiary: AccountId, amount: bigint, purpose?: string): void {
    if (amount === 0n) return;
    this.ledger.transfer(this.bucketId(fromBucket), beneficiary, amount, {
      ...(purpose !== undefined ? { purpose } : {}),
      memo: `disbursement${purpose ? ` (${purpose})` : ""}`,
      tags: { kind: "disbursement", fund: this.name },
    });
  }

  snapshot(): FundSnapshot {
    const buckets: Record<string, string> = {};
    for (const [name] of this.buckets) buckets[name] = this.bucketBalance(name).toString();
    return {
      at: this.clock.now(),
      fund: this.name,
      totalAssets: this.totalAssets().toString(),
      shareSupply: this.totalShares.toString(),
      navPerShare: this.navPerShare().toString(),
      buckets,
    };
  }
}

export interface FundSnapshot {
  at: number;
  fund: string;
  totalAssets: string;
  shareSupply: string;
  navPerShare: string;
  buckets: Record<string, string>;
}

export { NAV_PRECISION };
