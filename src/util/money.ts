/**
 * Money helpers.
 *
 * All monetary amounts in FundOS are represented as `bigint` in the smallest
 * indivisible unit of the currency (e.g. cents for USD, wei-like minor units
 * for a stablecoin). Using integers avoids floating-point rounding drift that
 * is unacceptable when moving real value around.
 */

export const BPS_DENOMINATOR = 10_000n;

/** Number of basis points in 100% (i.e. 100% === 10000 bps). */
export type Bps = bigint;

/** Throw if an amount is negative — balances and transfers must be >= 0. */
export function assertNonNegative(amount: bigint, label = "amount"): void {
  if (amount < 0n) {
    throw new RangeError(`${label} must be non-negative, received ${amount}`);
  }
}

/**
 * Multiply an amount by a basis-point rate, rounding down.
 * e.g. `applyBps(1000n, 250n)` === `25n` (2.5% of 1000).
 */
export function applyBps(amount: bigint, bps: Bps): bigint {
  assertNonNegative(amount, "amount");
  if (bps < 0n) throw new RangeError(`bps must be non-negative, received ${bps}`);
  return (amount * bps) / BPS_DENOMINATOR;
}

/** Sum a list of bigint amounts. */
export function sum(amounts: Iterable<bigint>): bigint {
  let total = 0n;
  for (const a of amounts) total += a;
  return total;
}

/** Absolute value for bigint. */
export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Format minor units as a human readable decimal string.
 * `formatUnits(123456n, 2)` -> "1234.56".
 */
export function formatUnits(amount: bigint, decimals = 2): string {
  const negative = amount < 0n;
  const digits = abs(amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const frac = decimals > 0 ? "." + digits.slice(digits.length - decimals) : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}
