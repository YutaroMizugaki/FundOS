import { applyBps, type Bps } from "../util/money.js";
import {
  type AccountId,
  type MoneyPolicy,
  type PolicyContext,
  PolicyViolation,
  type TransferIntent,
} from "./types.js";

/**
 * Only permit outbound transfers to an explicit allow-list of recipients.
 * Internal (policy-derived) transfers such as fees are exempt.
 */
export class AllowListPolicy implements MoneyPolicy {
  readonly name = "allow-list";
  private readonly allowed: Set<AccountId>;

  constructor(allowed: Iterable<AccountId>) {
    this.allowed = new Set(allowed);
  }

  allow(id: AccountId): this {
    this.allowed.add(id);
    return this;
  }

  authorize(intent: TransferIntent): void {
    if (intent.internal) return;
    if (!this.allowed.has(intent.to)) {
      throw new PolicyViolation(this.name, `recipient ${intent.to} is not allow-listed`);
    }
  }
}

/** Block transfers to sanctioned / frozen recipients. */
export class DenyListPolicy implements MoneyPolicy {
  readonly name = "deny-list";
  private readonly denied: Set<AccountId>;

  constructor(denied: Iterable<AccountId> = []) {
    this.denied = new Set(denied);
  }

  deny(id: AccountId): this {
    this.denied.add(id);
    return this;
  }

  authorize(intent: TransferIntent): void {
    if (this.denied.has(intent.to)) {
      throw new PolicyViolation(this.name, `recipient ${intent.to} is denied`);
    }
  }
}

/**
 * Lock all outbound value until `unlockAt`. Models vesting / time-locked
 * grants — the money literally cannot move before it is due.
 */
export class TimeLockPolicy implements MoneyPolicy {
  readonly name = "time-lock";

  constructor(private readonly unlockAt: number) {}

  authorize(intent: TransferIntent, ctx: PolicyContext): void {
    if (intent.internal) return;
    if (ctx.now < this.unlockAt) {
      throw new PolicyViolation(
        this.name,
        `funds are time-locked until ${this.unlockAt} (now ${ctx.now})`,
      );
    }
  }
}

/**
 * Rolling-window spending cap: at most `limit` may leave the account within
 * any `windowMs` window. Keeps a small ledger of recent outflows.
 */
export class SpendingLimitPolicy implements MoneyPolicy {
  readonly name = "spending-limit";
  private readonly history: Array<{ at: number; amount: bigint }> = [];

  constructor(
    private readonly limit: bigint,
    private readonly windowMs: number,
  ) {
    if (limit < 0n) throw new RangeError("limit must be non-negative");
    if (windowMs <= 0) throw new RangeError("windowMs must be > 0");
  }

  private spentWithin(now: number): bigint {
    const cutoff = now - this.windowMs;
    let total = 0n;
    for (const entry of this.history) {
      if (entry.at > cutoff) total += entry.amount;
    }
    return total;
  }

  authorize(intent: TransferIntent, ctx: PolicyContext): void {
    if (intent.internal) return;
    const projected = this.spentWithin(ctx.now) + intent.amount;
    if (projected > this.limit) {
      throw new PolicyViolation(
        this.name,
        `transfer of ${intent.amount} would exceed spending limit ${this.limit} within window`,
      );
    }
  }

  settle(intent: TransferIntent, ctx: PolicyContext): void {
    if (intent.internal) return;
    this.history.push({ at: ctx.now, amount: intent.amount });
    // Compact old history so it doesn't grow without bound.
    const cutoff = ctx.now - this.windowMs;
    while (this.history.length > 0 && this.history[0]!.at <= cutoff) {
      this.history.shift();
    }
  }
}

/**
 * Earmarked money can only be spent for a matching purpose. This is the heart
 * of "programmable money": value tagged for `education` cannot be redirected to
 * anything else, no matter who controls the account.
 */
export class EarmarkPolicy implements MoneyPolicy {
  readonly name = "earmark";
  private readonly purposes: Set<string>;

  constructor(purposes: Iterable<string>) {
    this.purposes = new Set(purposes);
  }

  authorize(intent: TransferIntent): void {
    if (intent.internal) return;
    if (!intent.purpose || !this.purposes.has(intent.purpose)) {
      throw new PolicyViolation(
        this.name,
        `funds are earmarked for [${[...this.purposes].join(", ")}]; ` +
          `transfer purpose "${intent.purpose ?? "none"}" is not permitted`,
      );
    }
  }
}

/**
 * Route a percentage fee to a collector on every outbound transfer. Emitted as
 * an internal, atomic side-transfer so it settles together with the principal.
 */
export class FeePolicy implements MoneyPolicy {
  readonly name = "fee";

  constructor(
    private readonly feeBps: Bps,
    private readonly collector: AccountId,
  ) {
    if (feeBps < 0n) throw new RangeError("feeBps must be non-negative");
  }

  derive(intent: TransferIntent): TransferIntent[] {
    if (intent.internal) return [];
    const fee = applyBps(intent.amount, this.feeBps);
    if (fee === 0n) return [];
    return [
      {
        from: intent.from,
        to: this.collector,
        amount: fee,
        at: intent.at,
        memo: `fee ${this.feeBps}bps on ${intent.memo ?? "transfer"}`,
        internal: true,
        tags: { kind: "fee" },
      },
    ];
  }
}
