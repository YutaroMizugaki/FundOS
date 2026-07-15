import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulationClock } from "../src/clock.js";
import { Fund, NAV_PRECISION } from "../src/fund/fund.js";
import { Ledger } from "../src/money/ledger.js";

function setup() {
  const clock = new SimulationClock(0);
  const ledger = new Ledger(clock);
  const fund = new Fund({
    name: "Test Fund",
    ledger,
    clock,
    buckets: [{ name: "intake" }, { name: "growth" }, { name: "reserve" }],
    intakeBucket: "intake",
    liquidBucket: "intake",
  });
  return { clock, ledger, fund };
}

test("first contribution mints shares 1:1 at NAV 1.0", () => {
  const { ledger, fund } = setup();
  const investor = ledger.open();
  ledger.mint(investor.id, 1_000n);

  const result = fund.contribute(investor.id, 1_000n);
  assert.equal(result.sharesMinted, 1_000n);
  assert.equal(fund.shareSupply, 1_000n);
  assert.equal(fund.totalAssets(), 1_000n);
  assert.equal(fund.navPerShare(), NAV_PRECISION);
});

test("second contributor gets shares at the prevailing NAV after gains", () => {
  const { ledger, fund } = setup();
  const a = ledger.open();
  const b = ledger.open();
  ledger.mint(a.id, 1_000n);
  ledger.mint(b.id, 1_000n);

  fund.contribute(a.id, 1_000n); // 1000 shares, assets 1000
  fund.applyReturn("intake", 1_000n); // assets now 2000, NAV 2.0

  const result = fund.contribute(b.id, 1_000n); // buys at NAV 2.0 -> 500 shares
  assert.equal(result.sharesMinted, 500n);
  assert.equal(fund.shareSupply, 1_500n);
  assert.equal(fund.totalAssets(), 3_000n);
});

test("redemption pays out NAV value and burns shares", () => {
  const { ledger, fund } = setup();
  const investor = ledger.open();
  ledger.mint(investor.id, 1_000n);
  fund.contribute(investor.id, 1_000n);
  fund.applyReturn("intake", 1_000n); // NAV 2.0

  const result = fund.redeem(investor.id, 500n);
  assert.equal(result.amountOut, 1_000n); // 500 shares * NAV 2.0
  assert.equal(fund.sharesOf(investor.id), 500n);
  assert.equal(ledger.balanceOf(investor.id), 1_000n);
});

test("redemption fails when the liquid bucket is illiquid", () => {
  const { ledger, fund } = setup();
  const investor = ledger.open();
  ledger.mint(investor.id, 1_000n);
  fund.contribute(investor.id, 1_000n);
  // Move all assets out of the liquid (intake) bucket.
  fund.moveBetweenBuckets("intake", "growth", 1_000n);
  assert.throws(() => fund.redeem(investor.id, 500n), /insufficient liquidity/);
});

test("moveBetweenBuckets conserves total assets", () => {
  const { ledger, fund } = setup();
  const investor = ledger.open();
  ledger.mint(investor.id, 1_000n);
  fund.contribute(investor.id, 1_000n);

  fund.moveBetweenBuckets("intake", "reserve", 300n);
  assert.equal(fund.bucketBalance("intake"), 700n);
  assert.equal(fund.bucketBalance("reserve"), 300n);
  assert.equal(fund.totalAssets(), 1_000n);
});

test("applyReturn can model a loss capped at the bucket balance", () => {
  const { ledger, fund } = setup();
  const investor = ledger.open();
  ledger.mint(investor.id, 1_000n);
  fund.contribute(investor.id, 1_000n);

  fund.applyReturn("intake", -400n);
  assert.equal(fund.totalAssets(), 600n);
  fund.applyReturn("intake", -10_000n); // capped
  assert.equal(fund.totalAssets(), 0n);
});

test("invalid bucket configuration is rejected", () => {
  const clock = new SimulationClock(0);
  const ledger = new Ledger(clock);
  assert.throws(
    () =>
      new Fund({
        name: "bad",
        ledger,
        clock,
        buckets: [{ name: "intake" }],
        intakeBucket: "does-not-exist",
      }),
    /is not a declared bucket/,
  );
});
