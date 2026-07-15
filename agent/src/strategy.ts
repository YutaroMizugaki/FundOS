import type { Address } from "viem";
import type { PolicySnapshot, StrategyContext, TransferProposal } from "./types.js";

/**
 * Simple target-weight rebalancer: proposes moving excess cash above target
 * to a configured yield sink address when drift exceeds threshold.
 */
export class TargetWeightStrategy {
  constructor(
    private readonly yieldSink: Address,
    private readonly targetCashBps: number = 2000,
    private readonly rebalanceThresholdBps: number = 500,
  ) {}

  propose(ctx: StrategyContext, policy: PolicySnapshot): TransferProposal | null {
    const cashBps = Number((policy.cashBalance * 10_000n) / policy.totalAssets);
    const drift = cashBps - this.targetCashBps;

    if (Math.abs(drift) < this.rebalanceThresholdBps) {
      return null;
    }

    const targetCash = (policy.totalAssets * BigInt(this.targetCashBps)) / 10_000n;
    const excess = policy.cashBalance - targetCash;
    if (excess <= 0n) return null;

    const maxByPolicy = (policy.totalAssets * BigInt(policy.maxTransferBps)) / 10_000n;
    const minReserve = (policy.totalAssets * BigInt(policy.minCashReserveBps)) / 10_000n;
    const maxDrawable = policy.cashBalance > minReserve ? policy.cashBalance - minReserve : 0n;
    const remainingDaily = policy.dailySpendCap - policy.dailySpendToday;

    let amount = excess < maxByPolicy ? excess : maxByPolicy;
    if (amount > maxDrawable) amount = maxDrawable;
    if (amount > remainingDaily) amount = remainingDaily;
    if (amount <= 0n) return null;

    return {
      asset: Object.keys(ctx.targetAllocationBps)[0] as Address,
      to: this.yieldSink,
      amount,
      reason: `rebalance: cash ${cashBps}bps vs target ${this.targetCashBps}bps`,
    };
  }
}
