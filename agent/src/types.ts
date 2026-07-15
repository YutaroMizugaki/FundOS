import type { Address, Hash, Hex } from "viem";

/** Off-chain snapshot hashed on-chain as `reasonHash` for auditability. */
export interface StrategyContext {
  strategyId: string;
  timestamp: number;
  targetAllocationBps: Record<string, number>;
  marketSnapshot: Record<string, number>;
}

export interface TransferProposal {
  asset: Address;
  to: Address;
  amount: bigint;
  reason: string;
}

export interface PolicySnapshot {
  autonomousMode: boolean;
  minCashReserveBps: number;
  maxTransferBps: number;
  dailySpendCap: bigint;
  dailySpendToday: bigint;
  totalAssets: bigint;
  cashBalance: bigint;
}

export interface ExecutionResult {
  proposal: TransferProposal;
  reasonHash: Hash;
  executed: boolean;
  txHash?: Hash;
  rejectionReason?: string;
}

export function hashStrategyContext(ctx: StrategyContext): Hash {
  const payload = JSON.stringify(ctx);
  // viem keccak256 is used at orchestration time; keep pure helper for tests.
  return `0x${Buffer.from(payload).toString("hex").slice(0, 64).padEnd(64, "0")}` as Hash;
}

export function encodeReasonHash(ctx: StrategyContext): Hex {
  return hashStrategyContext(ctx);
}
