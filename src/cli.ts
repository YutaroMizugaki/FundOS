#!/usr/bin/env node
/**
 * FundOS CLI — spin up and simulate a self-driving endowment from the terminal.
 *
 *   fundos [--years N] [--gift DOLLARS] [--yield-bps N] [--spend-bps N] [--json]
 */
import {
  AutonomousEngine,
  Fund,
  Ledger,
  MS_PER_DAY,
  MS_PER_YEAR,
  ReserveFloorGuard,
  SimulationClock,
  SpendingRule,
  SweepRule,
  TargetAllocationRule,
  YieldRule,
  formatUnits,
} from "./index.js";

interface Options {
  years: number;
  gift: number;
  yieldBps: bigint;
  spendBps: bigint;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { years: 10, gift: 5_000_000, yieldBps: 600n, spendBps: 400n, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--years":
        opts.years = Number(next());
        break;
      case "--gift":
        opts.gift = Number(next());
        break;
      case "--yield-bps":
        opts.yieldBps = BigInt(next() ?? "0");
        break;
      case "--spend-bps":
        opts.spendBps = BigInt(next() ?? "0");
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`FundOS — self-driving fund simulator

Usage: fundos [options]

Options:
  --years N        Number of years to simulate (default 10)
  --gift DOLLARS   Founding contribution in dollars (default 5000000)
  --yield-bps N    Annualised investment return in bps (default 600 = 6%)
  --spend-bps N    Annualised spending rate in bps (default 400 = 4%)
  --json           Emit the final snapshot as JSON
  -h, --help       Show this help`);
}

function run(opts: Options): void {
  const USD = (dollars: number) => BigInt(Math.round(dollars * 100));
  const start = Date.UTC(2026, 0, 1);
  const clock = new SimulationClock(start);
  const ledger = new Ledger(clock);

  const donor = ledger.open({ label: "donor" });
  const beneficiary = ledger.open({ label: "beneficiary" });
  ledger.mint(donor.id, USD(opts.gift));

  const fund = new Fund({
    name: "CLI Endowment",
    ledger,
    clock,
    buckets: [{ name: "intake" }, { name: "growth" }, { name: "reserve" }],
    intakeBucket: "intake",
    liquidBucket: "reserve",
  });

  new AutonomousEngine(fund, clock)
    .register(
      new ReserveFloorGuard({ watchBucket: "reserve", floor: USD(1_000) }),
      new SweepRule("intake", "growth"),
      new YieldRule({ bucket: "growth", annualBps: opts.yieldBps }),
      new TargetAllocationRule({ weights: { growth: 9_000n, reserve: 1_000n }, driftBps: 50n }),
      new SpendingRule({
        sourceBucket: "reserve",
        periodMs: 30 * MS_PER_DAY,
        annualSpendBps: opts.spendBps,
        beneficiaries: [{ account: beneficiary.id, weightBps: 10_000n, purpose: "grant" }],
      }),
    )
    .autopilot(clock, 7 * MS_PER_DAY);

  fund.contribute(donor.id, USD(opts.gift), "founding gift");
  clock.advanceTo(start + opts.years * MS_PER_YEAR);

  const distributed = ledger.balanceOf(beneficiary.id);
  const snap = fund.snapshot();

  if (opts.json) {
    console.log(JSON.stringify({ ...snap, distributed: distributed.toString() }, null, 2));
    return;
  }

  console.log(`FundOS simulation — ${opts.years}y autonomous run`);
  console.log(`  founding gift : $${formatUnits(USD(opts.gift))}`);
  console.log(`  total assets  : $${formatUnits(BigInt(snap.totalAssets))}`);
  console.log(`  distributed   : $${formatUnits(distributed)}`);
  console.log(`  NAV/share     : ${formatUnits(BigInt(snap.navPerShare), 6)}`);
  console.log(`  ledger events : ${ledger.events.size}`);
}

run(parseArgs(process.argv.slice(2)));
