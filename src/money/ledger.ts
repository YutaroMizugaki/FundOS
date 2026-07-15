import type { Clock } from "../clock.js";
import { EventLog } from "../events.js";
import { nextId } from "../util/id.js";
import { assertNonNegative } from "../util/money.js";
import {
  type AccountId,
  type MoneyPolicy,
  type PolicyContext,
  PolicyViolation,
  type TransferIntent,
} from "./types.js";

export interface Account {
  readonly id: AccountId;
  readonly label: string;
  balance: bigint;
  readonly policies: MoneyPolicy[];
  readonly metadata: Record<string, unknown>;
}

export interface OpenAccountOptions {
  label?: string;
  id?: AccountId;
  policies?: MoneyPolicy[];
  metadata?: Record<string, unknown>;
}

export interface TransferOptions {
  purpose?: string;
  memo?: string;
  tags?: Record<string, string>;
}

/**
 * The Ledger is the programmable-money substrate. It owns account balances and
 * enforces the money policies attached to each source account on every
 * transfer, mint and burn. All value movements are atomic: if any policy vetoes
 * or a derived (fee) transfer cannot be covered, nothing changes.
 */
export class Ledger {
  private readonly accounts = new Map<AccountId, Account>();

  constructor(
    private readonly clock: Clock,
    readonly events: EventLog = new EventLog(),
    /** The currency's smallest-unit exponent, used only for display. */
    readonly decimals = 2,
  ) {}

  open(options: OpenAccountOptions = {}): Account {
    const id = options.id ?? nextId("acct");
    if (this.accounts.has(id)) throw new Error(`account ${id} already exists`);
    const account: Account = {
      id,
      label: options.label ?? id,
      balance: 0n,
      policies: options.policies ? [...options.policies] : [],
      metadata: options.metadata ? { ...options.metadata } : {},
    };
    this.accounts.set(id, account);
    this.events.emit(this.clock.now(), "account.opened", `opened ${account.label}`, {
      id,
      label: account.label,
    });
    return account;
  }

  has(id: AccountId): boolean {
    return this.accounts.has(id);
  }

  private require(id: AccountId): Account {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`unknown account ${id}`);
    return account;
  }

  balanceOf(id: AccountId): bigint {
    return this.require(id).balance;
  }

  /** Attach an additional policy to an existing account. */
  attachPolicy(id: AccountId, policy: MoneyPolicy): void {
    this.require(id).policies.push(policy);
  }

  /** Total value in circulation across all accounts. */
  totalSupply(): bigint {
    let total = 0n;
    for (const account of this.accounts.values()) total += account.balance;
    return total;
  }

  /** Issue new units into an account (e.g. a deposit of external currency). */
  mint(id: AccountId, amount: bigint, memo?: string): void {
    assertNonNegative(amount, "mint amount");
    const account = this.require(id);
    account.balance += amount;
    this.events.emit(this.clock.now(), "money.minted", `minted into ${account.label}`, {
      id,
      amount: amount.toString(),
      memo,
    });
  }

  /** Destroy units from an account (e.g. a withdrawal of external currency). */
  burn(id: AccountId, amount: bigint, memo?: string): void {
    assertNonNegative(amount, "burn amount");
    const account = this.require(id);
    if (account.balance < amount) {
      throw new Error(`insufficient balance to burn ${amount} from ${account.label}`);
    }
    account.balance -= amount;
    this.events.emit(this.clock.now(), "money.burned", `burned from ${account.label}`, {
      id,
      amount: amount.toString(),
      memo,
    });
  }

  private context(): PolicyContext {
    return {
      now: this.clock.now(),
      balanceOf: (id) => this.balanceOf(id),
    };
  }

  /**
   * Move `amount` from one account to another, running all source-account
   * policies. Returns the list of transfers that actually settled (the
   * principal plus any derived fees).
   */
  transfer(
    from: AccountId,
    to: AccountId,
    amount: bigint,
    options: TransferOptions = {},
  ): TransferIntent[] {
    assertNonNegative(amount, "transfer amount");
    const intent: TransferIntent = {
      from,
      to,
      amount,
      at: this.clock.now(),
      ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
      ...(options.memo !== undefined ? { memo: options.memo } : {}),
      tags: options.tags ?? {},
    };
    return this.execute(intent);
  }

  private execute(intent: TransferIntent): TransferIntent[] {
    const source = this.require(intent.from);
    this.require(intent.to);
    const ctx = this.context();

    // 1. Authorize against every policy on the source account.
    for (const policy of source.policies) {
      policy.authorize?.(intent, ctx);
    }

    // 2. Collect derived (internal) transfers, e.g. fees.
    const derived: TransferIntent[] = [];
    for (const policy of source.policies) {
      if (policy.derive) derived.push(...policy.derive(intent, ctx));
    }

    // 3. Ensure the source can cover principal + all derived transfers it owes.
    const owedFromSource =
      intent.amount + derived.filter((d) => d.from === intent.from).reduce((s, d) => s + d.amount, 0n);
    if (source.balance < owedFromSource) {
      throw new PolicyViolation(
        "solvency",
        `insufficient balance in ${source.label}: needs ${owedFromSource}, has ${source.balance}`,
      );
    }

    // 4. Settle principal, then derived transfers, atomically.
    this.settleOne(intent);
    for (const d of derived) this.settleOne(d);

    // 5. Let policies update their internal state.
    for (const policy of source.policies) policy.settle?.(intent, ctx);

    return [intent, ...derived];
  }

  private settleOne(intent: TransferIntent): void {
    const from = this.require(intent.from);
    const to = this.require(intent.to);
    if (from.balance < intent.amount) {
      throw new PolicyViolation(
        "solvency",
        `insufficient balance in ${from.label}: needs ${intent.amount}, has ${from.balance}`,
      );
    }
    from.balance -= intent.amount;
    to.balance += intent.amount;
    this.events.emit(
      intent.at,
      intent.internal ? "money.fee" : "money.transferred",
      `${from.label} -> ${to.label}`,
      {
        from: intent.from,
        to: intent.to,
        amount: intent.amount.toString(),
        purpose: intent.purpose,
        memo: intent.memo,
      },
    );
  }
}
