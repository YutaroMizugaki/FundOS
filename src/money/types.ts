import type { Bps } from "../util/money.js";

export type AccountId = string;

/**
 * A single value-transfer request flowing through the ledger. Programmable
 * money policies inspect and can veto or augment these intents before they
 * settle.
 */
export interface TransferIntent {
  from: AccountId;
  to: AccountId;
  amount: bigint;
  /** Wall-clock time the transfer is attempted (ms since epoch). */
  at: number;
  /**
   * Optional earmark: what this money is *for*. Earmarked accounts only
   * release funds when the purpose matches (see EarmarkPolicy).
   */
  purpose?: string;
  memo?: string;
  /**
   * Transfers spawned by a policy (e.g. a fee) are flagged internal and do not
   * themselves recurse through policy evaluation.
   */
  internal?: boolean;
  tags: Readonly<Record<string, string>>;
}

/** Read-only view a policy gets while deciding on a transfer. */
export interface PolicyContext {
  now: number;
  balanceOf(id: AccountId): bigint;
}

/**
 * Programmable money is money that carries its own rules. A `MoneyPolicy` is
 * attached to a source account and participates in every outbound transfer:
 *
 *  - `authorize` may veto the transfer by throwing {@link PolicyViolation}.
 *  - `derive` may return extra transfers to run atomically alongside it
 *    (used e.g. to route a fee).
 *  - `settle` updates the policy's internal state after everything succeeds
 *    (used e.g. to record spending against a rolling limit).
 */
export interface MoneyPolicy {
  readonly name: string;
  authorize?(intent: TransferIntent, ctx: PolicyContext): void;
  derive?(intent: TransferIntent, ctx: PolicyContext): TransferIntent[];
  settle?(intent: TransferIntent, ctx: PolicyContext): void;
}

export class PolicyViolation extends Error {
  constructor(
    readonly policy: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export type { Bps };
