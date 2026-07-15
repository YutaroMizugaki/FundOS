import assert from "node:assert/strict";
import { test } from "node:test";
import { abs, applyBps, formatUnits, sum } from "../src/util/money.js";

test("applyBps computes basis-point fractions, rounding down", () => {
  assert.equal(applyBps(1_000n, 250n), 25n); // 2.5%
  assert.equal(applyBps(10_000n, 10_000n), 10_000n); // 100%
  assert.equal(applyBps(101n, 500n), 5n); // 5.05 -> 5 (floor)
  assert.equal(applyBps(0n, 500n), 0n);
});

test("applyBps rejects negative bps", () => {
  assert.throws(() => applyBps(100n, -1n), RangeError);
});

test("sum and abs", () => {
  assert.equal(sum([1n, 2n, 3n]), 6n);
  assert.equal(sum([]), 0n);
  assert.equal(abs(-5n), 5n);
  assert.equal(abs(5n), 5n);
});

test("formatUnits renders minor units as decimals", () => {
  assert.equal(formatUnits(123_456n, 2), "1234.56");
  assert.equal(formatUnits(5n, 2), "0.05");
  assert.equal(formatUnits(-99n, 2), "-0.99");
  assert.equal(formatUnits(100n, 0), "100");
});
