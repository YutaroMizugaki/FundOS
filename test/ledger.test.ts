import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulationClock } from "../src/clock.js";
import { Ledger } from "../src/money/ledger.js";
import {
  AllowListPolicy,
  DenyListPolicy,
  EarmarkPolicy,
  FeePolicy,
  SpendingLimitPolicy,
  TimeLockPolicy,
} from "../src/money/policies.js";
import { PolicyViolation } from "../src/money/types.js";

function setup() {
  const clock = new SimulationClock(0);
  const ledger = new Ledger(clock);
  return { clock, ledger };
}

test("mint, transfer and burn move balances and conserve supply", () => {
  const { ledger } = setup();
  const a = ledger.open({ label: "a" });
  const b = ledger.open({ label: "b" });
  ledger.mint(a.id, 1_000n);
  assert.equal(ledger.totalSupply(), 1_000n);

  ledger.transfer(a.id, b.id, 400n);
  assert.equal(ledger.balanceOf(a.id), 600n);
  assert.equal(ledger.balanceOf(b.id), 400n);
  assert.equal(ledger.totalSupply(), 1_000n);

  ledger.burn(b.id, 100n);
  assert.equal(ledger.balanceOf(b.id), 300n);
  assert.equal(ledger.totalSupply(), 900n);
});

test("overdraft transfer is rejected and leaves balances untouched", () => {
  const { ledger } = setup();
  const a = ledger.open();
  const b = ledger.open();
  ledger.mint(a.id, 100n);
  assert.throws(() => ledger.transfer(a.id, b.id, 200n), PolicyViolation);
  assert.equal(ledger.balanceOf(a.id), 100n);
  assert.equal(ledger.balanceOf(b.id), 0n);
});

test("allow-list policy blocks non-listed recipients", () => {
  const { ledger } = setup();
  const good = ledger.open();
  const bad = ledger.open();
  const src = ledger.open({ policies: [new AllowListPolicy([good.id])] });
  ledger.mint(src.id, 1_000n);

  ledger.transfer(src.id, good.id, 100n);
  assert.equal(ledger.balanceOf(good.id), 100n);
  assert.throws(() => ledger.transfer(src.id, bad.id, 100n), PolicyViolation);
});

test("deny-list policy blocks sanctioned recipients", () => {
  const { ledger } = setup();
  const sanctioned = ledger.open();
  const src = ledger.open({ policies: [new DenyListPolicy([sanctioned.id])] });
  ledger.mint(src.id, 1_000n);
  assert.throws(() => ledger.transfer(src.id, sanctioned.id, 10n), PolicyViolation);
});

test("time-lock policy blocks transfers until unlock time", () => {
  const { clock, ledger } = setup();
  const dst = ledger.open();
  const src = ledger.open({ policies: [new TimeLockPolicy(100)] });
  ledger.mint(src.id, 1_000n);

  assert.throws(() => ledger.transfer(src.id, dst.id, 10n), PolicyViolation);
  clock.advanceTo(100);
  ledger.transfer(src.id, dst.id, 10n);
  assert.equal(ledger.balanceOf(dst.id), 10n);
});

test("spending-limit policy enforces a rolling window cap", () => {
  const { clock, ledger } = setup();
  const dst = ledger.open();
  const src = ledger.open({ policies: [new SpendingLimitPolicy(100n, 1_000)] });
  ledger.mint(src.id, 10_000n);

  ledger.transfer(src.id, dst.id, 60n);
  ledger.transfer(src.id, dst.id, 40n); // exactly at the 100 cap
  assert.throws(() => ledger.transfer(src.id, dst.id, 1n), PolicyViolation);

  // Window slides; spending is allowed again.
  clock.advanceTo(1_001);
  ledger.transfer(src.id, dst.id, 90n);
  assert.equal(ledger.balanceOf(dst.id), 190n);
});

test("earmark policy only releases funds for matching purpose", () => {
  const { ledger } = setup();
  const dst = ledger.open();
  const src = ledger.open({ policies: [new EarmarkPolicy(["education"])] });
  ledger.mint(src.id, 1_000n);

  assert.throws(() => ledger.transfer(src.id, dst.id, 10n, { purpose: "gambling" }), PolicyViolation);
  assert.throws(() => ledger.transfer(src.id, dst.id, 10n), PolicyViolation);
  ledger.transfer(src.id, dst.id, 10n, { purpose: "education" });
  assert.equal(ledger.balanceOf(dst.id), 10n);
});

test("fee policy routes a derived, atomic fee to the collector", () => {
  const { ledger } = setup();
  const collector = ledger.open();
  const dst = ledger.open();
  const src = ledger.open({ policies: [new FeePolicy(100n, collector.id)] }); // 1%
  ledger.mint(src.id, 1_000n);

  const settled = ledger.transfer(src.id, dst.id, 200n);
  assert.equal(ledger.balanceOf(dst.id), 200n);
  assert.equal(ledger.balanceOf(collector.id), 2n); // 1% of 200
  assert.equal(ledger.balanceOf(src.id), 798n);
  assert.equal(settled.length, 2); // principal + fee
});

test("transfer is atomic when principal plus fee exceeds balance", () => {
  const { ledger } = setup();
  const collector = ledger.open();
  const dst = ledger.open();
  const src = ledger.open({ policies: [new FeePolicy(10_000n, collector.id)] }); // 100% fee
  ledger.mint(src.id, 150n);

  // principal 100 + fee 100 = 200 > 150, so nothing should move.
  assert.throws(() => ledger.transfer(src.id, dst.id, 100n), PolicyViolation);
  assert.equal(ledger.balanceOf(src.id), 150n);
  assert.equal(ledger.balanceOf(dst.id), 0n);
  assert.equal(ledger.balanceOf(collector.id), 0n);
});
