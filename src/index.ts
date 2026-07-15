/**
 * FundOS — a programmable-money engine for building self-driving funds.
 *
 * Layers:
 *   1. Programmable money — {@link Ledger} + {@link MoneyPolicy} implementations.
 *   2. Autonomous fund     — {@link Fund} (buckets, shares, NAV).
 *   3. Autopilot           — {@link AutonomousEngine} + {@link Rule}s, driven by
 *                            the {@link SimulationClock}.
 */

export {
  SimulationClock,
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  MS_PER_YEAR,
} from "./clock.js";
export type { Clock, Cancellable } from "./clock.js";

export { EventLog } from "./events.js";
export type { FundEvent, EventListener } from "./events.js";

export { Ledger } from "./money/ledger.js";
export type { Account, OpenAccountOptions, TransferOptions } from "./money/ledger.js";
export {
  AllowListPolicy,
  DenyListPolicy,
  TimeLockPolicy,
  SpendingLimitPolicy,
  EarmarkPolicy,
  FeePolicy,
} from "./money/policies.js";
export { PolicyViolation } from "./money/types.js";
export type {
  AccountId,
  Bps,
  MoneyPolicy,
  PolicyContext,
  TransferIntent,
} from "./money/types.js";

export { Fund, NAV_PRECISION } from "./fund/fund.js";
export type {
  FundConfig,
  BucketConfig,
  ContributionResult,
  RedemptionResult,
  FundSnapshot,
} from "./fund/fund.js";

export { AutonomousEngine } from "./fund/engine.js";
export type { Rule, RuleContext } from "./fund/engine.js";

export {
  SweepRule,
  TargetAllocationRule,
  YieldRule,
  SpendingRule,
  ReserveFloorGuard,
} from "./fund/rules.js";
export type {
  TargetAllocationConfig,
  YieldConfig,
  SpendingConfig,
  Beneficiary,
  ReserveFloorConfig,
} from "./fund/rules.js";

export {
  applyBps,
  formatUnits,
  sum,
  abs,
  BPS_DENOMINATOR,
} from "./util/money.js";
