import assert from "node:assert/strict";
import { test } from "node:test";
import { MS_PER_DAY, MS_PER_YEAR, SimulationClock } from "../src/clock.js";
import { AutonomousEngine } from "../src/fund/engine.js";
import { Fund } from "../src/fund/fund.js";
import {
  ReserveFloorGuard,
  SpendingRule,
  SweepRule,
  TargetAllocationRule,
  YieldRule,
} from "../src/fund/rules.js";
import { Ledger } from "../src/money/ledger.js";

function setup(start = 0) {
  const clock = new SimulationClock(start);
  const ledger = new Ledger(clock);
  const fund = new Fund({
    name: "Rules Fund",
    ledger,
    clock,
    buckets: [{ name: "intake" }, { name: "growth" }, { name: "reserve" }],
    intakeBucket: "intake",
    liquidBucket: "reserve",
  });
  const engine = new AutonomousEngine(fund, clock);
  const investor = ledger.open();
  ledger.mint(investor.id, 10_000_000n);
  return { clock, ledger, fund, engine, investor };
}

test("SweepRule moves idle intake into the working bucket", () => {
  const { fund, engine, investor } = setup();
  fund.contribute(investor.id, 1_000n);
  engine.register(new SweepRule("intake", "growth"));
  engine.tick();
  assert.equal(fund.bucketBalance("intake"), 0n);
  assert.equal(fund.bucketBalance("growth"), 1_000n);
});

test("TargetAllocationRule rebalances toward target weights", () => {
  const { fund, engine, investor } = setup();
  fund.contribute(investor.id, 1_000n);
  fund.moveBetweenBuckets("intake", "growth", 1_000n); // all in growth
  engine.register(
    new TargetAllocationRule({ weights: { growth: 9_000n, reserve: 1_000n }, driftBps: 50n }),
  );
  engine.tick();
  assert.equal(fund.bucketBalance("growth"), 900n);
  assert.equal(fund.bucketBalance("reserve"), 100n);
});

test("TargetAllocationRule does nothing when drift is under threshold", () => {
  const { fund, engine, investor } = setup();
  fund.contribute(investor.id, 1_000n);
  fund.moveBetweenBuckets("intake", "growth", 900n);
  fund.moveBetweenBuckets("intake", "reserve", 100n);
  engine.register(
    new TargetAllocationRule({ weights: { growth: 9_000n, reserve: 1_000n }, driftBps: 100n }),
  );
  engine.tick();
  assert.equal(fund.bucketBalance("growth"), 900n);
  assert.equal(fund.bucketBalance("reserve"), 100n);
});

test("YieldRule accrues proportional to elapsed time", () => {
  const { clock, fund, engine, investor } = setup();
  fund.contribute(investor.id, 1_000_000n);
  fund.moveBetweenBuckets("intake", "growth", 1_000_000n);
  engine.register(new YieldRule({ bucket: "growth", annualBps: 10_000n })); // 100%/yr

  engine.tick(); // primes lastAccruedAt, no accrual yet
  assert.equal(fund.bucketBalance("growth"), 1_000_000n);

  clock.advanceTo(MS_PER_YEAR);
  engine.tick(); // one full year at 100% -> doubles
  assert.equal(fund.bucketBalance("growth"), 2_000_000n);
});

test("SpendingRule distributes on schedule and respects the pause", () => {
  const { clock, ledger, fund, engine, investor } = setup();
  fund.contribute(investor.id, 1_200_000n);
  fund.moveBetweenBuckets("intake", "reserve", 1_200_000n);
  const beneficiary = ledger.open();

  engine.register(
    new SpendingRule({
      sourceBucket: "reserve",
      periodMs: 30 * MS_PER_DAY,
      annualSpendBps: 1_200n, // 12%/yr -> ~1%/period
      beneficiaries: [{ account: beneficiary.id, weightBps: 10_000n }],
      spendFromTotalAssets: false,
    }),
  );

  engine.tick(); // primes nextPayoutAt
  assert.equal(ledger.balanceOf(beneficiary.id), 0n);

  clock.advanceTo(30 * MS_PER_DAY);
  engine.tick(); // ~1% of 1,200,000 base
  assert.ok(ledger.balanceOf(beneficiary.id) > 0n);
  const afterFirst = ledger.balanceOf(beneficiary.id);

  // Pause: next scheduled payout is skipped.
  engine.pauseDistributions("test pause");
  clock.advanceTo(60 * MS_PER_DAY);
  engine.tick();
  assert.equal(ledger.balanceOf(beneficiary.id), afterFirst);
});

test("ReserveFloorGuard pauses and resumes around the floor", () => {
  const { fund, engine, investor } = setup();
  fund.contribute(investor.id, 10_000n);
  fund.moveBetweenBuckets("intake", "reserve", 500n); // below floor 1000

  engine.register(new ReserveFloorGuard({ watchBucket: "reserve", floor: 1_000n, resumeAbove: 2_000n }));
  engine.tick();
  assert.equal(engine.distributionsPaused, true);

  fund.moveBetweenBuckets("intake", "reserve", 2_000n); // reserve now 2500
  engine.tick();
  assert.equal(engine.distributionsPaused, false);
});

test("autopilot runs the full self-driving loop with no manual ticks", () => {
  const { clock, ledger, fund, engine, investor } = setup(Date.UTC(2026, 0, 1));
  const beneficiary = ledger.open();
  engine.register(
    new SweepRule("intake", "growth"),
    new YieldRule({ bucket: "growth", annualBps: 600n }),
    new TargetAllocationRule({ weights: { growth: 9_000n, reserve: 1_000n }, driftBps: 50n }),
    new SpendingRule({
      sourceBucket: "reserve",
      periodMs: 30 * MS_PER_DAY,
      annualSpendBps: 400n,
      beneficiaries: [{ account: beneficiary.id, weightBps: 10_000n, purpose: "grant" }],
    }),
  );
  engine.autopilot(clock, 7 * MS_PER_DAY);

  fund.contribute(investor.id, 5_000_000n);
  const startAssets = fund.totalAssets();
  clock.advanceTo(Date.UTC(2026, 0, 1) + 5 * MS_PER_YEAR);

  assert.ok(engine.tickCount > 200, `expected many autonomous ticks, got ${engine.tickCount}`);
  assert.ok(ledger.balanceOf(beneficiary.id) > 0n, "beneficiary should have received grants");
  // Principal preserved / grown despite spending.
  assert.ok(fund.totalAssets() >= startAssets, "assets should be preserved by the spending rule");
});
