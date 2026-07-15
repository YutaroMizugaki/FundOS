/**
 * FundOS JPYC Agent entrypoint.
 *
 * Environment:
 * - RPC_URL
 * - JPYC_NETWORK (ethereum | polygon | avalanche) — default: ethereum
 * - VAULT_ADDRESS
 * - POLICY_ADDRESS
 * - EXECUTOR_PRIVATE_KEY
 * - YIELD_SINK — 利回り先 (DEX LP, レンディング等)
 * - BASE_ASSET — optional, defaults to canonical JPYC
 */
import type { Address } from "viem";
import { FundAgentOrchestrator } from "./orchestrator.js";
import {
  DEFAULT_JPYC_POLICY,
  JPYC_ADDRESS,
  formatYen,
  resolveJPYCChain,
} from "./jpyc.js";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

async function main() {
  const network = env("JPYC_NETWORK", "ethereum");
  const chain = resolveJPYCChain(network);
  const baseAsset = (process.env.BASE_ASSET ?? JPYC_ADDRESS) as Address;

  const orchestrator = new FundAgentOrchestrator({
    rpcUrl: env("RPC_URL"),
    vaultAddress: env("VAULT_ADDRESS") as Address,
    policyAddress: env("POLICY_ADDRESS") as Address,
    executorPrivateKey: env("EXECUTOR_PRIVATE_KEY") as `0x${string}`,
    yieldSink: env("YIELD_SINK") as Address,
    chain,
    targetCashBps: DEFAULT_JPYC_POLICY.targetCashBps,
  });

  const ctx = {
    strategyId: "jpyc-target-weight-v1",
    timestamp: Date.now(),
    targetAllocationBps: { [baseAsset]: DEFAULT_JPYC_POLICY.targetCashBps },
    marketSnapshot: { jpycNetwork: network === "ethereum" ? 1 : 0 },
  };

  const result = await orchestrator.executeOnce(ctx);
  const output = {
    ...result,
    amountYen: result.proposal.amount > 0n ? formatYen(result.proposal.amount) : null,
  };
  console.log(JSON.stringify(output, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
