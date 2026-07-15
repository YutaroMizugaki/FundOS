/**
 * A fully self-driving perpetual scholarship endowment.
 *
 * Run with: `npm run demo`
 *
 * Once the donors contribute and the autopilot is armed, no human touches the
 * fund again: it invests contributions, compounds returns, rebalances income
 * into a spendable reserve, distributes scholarships every month under a 4%
 * spending rule, and automatically pauses payouts if the reserve is drained.
 */
import {
  AutonomousEngine,
  EarmarkPolicy,
  Fund,
  Ledger,
  MS_PER_DAY,
  MS_PER_YEAR,
  PolicyViolation,
  ReserveFloorGuard,
  SimulationClock,
  SpendingRule,
  SweepRule,
  TargetAllocationRule,
  YieldRule,
  formatUnits,
  type FundSnapshot,
} from "../src/index.js";

const USD = (dollars: number) => BigInt(Math.round(dollars * 100));
const money = (minor: bigint) => `$${formatUnits(minor, 2)}`;

const start = Date.UTC(2026, 0, 1);
const clock = new SimulationClock(start);
const ledger = new Ledger(clock, undefined, 2);

// --- External accounts -----------------------------------------------------
const donor = ledger.open({ label: "Donor: Founders" });
const scholarships = ledger.open({ label: "Beneficiary: Scholarships" });
const research = ledger.open({ label: "Beneficiary: Research grants" });
ledger.mint(donor.id, USD(10_000_000), "initial donor wealth");

// --- The fund --------------------------------------------------------------
const fund = new Fund({
  name: "Perpetual Scholarship Endowment",
  ledger,
  clock,
  buckets: [
    { name: "intake", label: "Intake" },
    { name: "growth", label: "Invested principal" },
    { name: "reserve", label: "Spendable reserve" },
  ],
  intakeBucket: "intake",
  liquidBucket: "reserve",
});

// --- Autopilot: the rules that make the fund self-driving -------------------
const engine = new AutonomousEngine(fund, clock);
engine.register(
  // Protect the fund: if the reserve is nearly drained, stop distributing.
  new ReserveFloorGuard({ watchBucket: "reserve", floor: USD(1_000), resumeAbove: USD(5_000) }),
  // Put freshly contributed capital to work.
  new SweepRule("intake", "growth"),
  // Compound ~6% annualised returns on invested principal.
  new YieldRule({ bucket: "growth", annualBps: 600n }),
  // Keep 10% of assets liquid in the reserve to fund spending.
  new TargetAllocationRule({ weights: { growth: 9_000n, reserve: 1_000n }, driftBps: 50n }),
  // Endowment 4% rule: distribute an annualised 4% of AUM every month.
  new SpendingRule({
    sourceBucket: "reserve",
    periodMs: 30 * MS_PER_DAY,
    annualSpendBps: 400n,
    beneficiaries: [
      { account: scholarships.id, weightBps: 7_000n, purpose: "scholarship" },
      { account: research.id, weightBps: 3_000n, purpose: "research" },
    ],
  }),
);

// Tick every week — but the rules are cadence-independent, so any interval works.
engine.autopilot(clock, 7 * MS_PER_DAY);

// --- Kick things off --------------------------------------------------------
fund.contribute(donor.id, USD(5_000_000), "founding gift");

console.log("=== Perpetual Scholarship Endowment ===");
console.log(`Founding gift: ${money(USD(5_000_000))}\n`);

const printSnapshot = (label: string, snap: FundSnapshot) => {
  console.log(`${label} (t+${Math.round((snap.at - start) / MS_PER_YEAR)}y)`);
  console.log(`  total assets : ${money(BigInt(snap.totalAssets))}`);
  console.log(`  growth       : ${money(BigInt(snap.buckets.growth ?? "0"))}`);
  console.log(`  reserve      : ${money(BigInt(snap.buckets.reserve ?? "0"))}`);
  console.log(`  NAV/share    : ${formatUnits(BigInt(snap.navPerShare), 6)}`);
};

printSnapshot("Year 0", fund.snapshot());

// Simulate 10 years of fully autonomous operation.
for (let year = 1; year <= 10; year++) {
  clock.advanceTo(start + year * MS_PER_YEAR);
  // A second donor tops the fund up in year 3.
  if (year === 3) fund.contribute(donor.id, USD(2_000_000), "matching gift");
  printSnapshot(`Year ${year}`, fund.snapshot());
}

// --- Tally the autonomous distributions ------------------------------------
const paidTo = (id: string) =>
  ledger.events
    .all("money.transferred")
    .filter((e) => e.data.to === id)
    .reduce((s, e) => s + BigInt(String(e.data.amount)), 0n);

console.log("\n--- Distributions over 10 years (fully autonomous) ---");
console.log(`  scholarships : ${money(paidTo(scholarships.id))}`);
console.log(`  research     : ${money(paidTo(research.id))}`);
console.log(`  reserve pauses triggered : ${ledger.events.all("engine.paused").length}`);
console.log(`  total ledger events      : ${ledger.events.size}`);

// --- Programmable money demo: earmarking ------------------------------------
console.log("\n--- Programmable money: earmarked funds ---");
const grant = ledger.open({ label: "Earmarked education grant" });
ledger.attachPolicy(grant.id, new EarmarkPolicy(["education"]));
ledger.mint(grant.id, USD(1_000));
try {
  ledger.transfer(grant.id, research.id, USD(500), { purpose: "research" });
} catch (err) {
  if (err instanceof PolicyViolation) {
    console.log(`  rejected misuse: ${err.message}`);
  } else throw err;
}
ledger.transfer(grant.id, scholarships.id, USD(500), { purpose: "education" });
console.log(`  allowed education spend of ${money(USD(500))} ✓`);
