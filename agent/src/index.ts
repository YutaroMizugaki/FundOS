/**
 * FundOS Agent entrypoint.
 *
 * Configure via environment variables:
 * - RPC_URL
 * - VAULT_ADDRESS
 * - POLICY_ADDRESS
 * - EXECUTOR_PRIVATE_KEY
 * - YIELD_SINK
 */
import type { Address } from "viem";
import { FundAgentOrchestrator } from "./orchestrator.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

async function main() {
  const orchestrator = new FundAgentOrchestrator({
    rpcUrl: env("RPC_URL"),
    vaultAddress: env("VAULT_ADDRESS") as Address,
    policyAddress: env("POLICY_ADDRESS") as Address,
    executorPrivateKey: env("EXECUTOR_PRIVATE_KEY") as `0x${string}`,
    yieldSink: env("YIELD_SINK") as Address,
  });

  const baseAsset = env("BASE_ASSET") as Address;
  const ctx = {
    strategyId: "target-weight-v1",
    timestamp: Date.now(),
    targetAllocationBps: { [baseAsset]: 2000 },
    marketSnapshot: {},
  };

  const result = await orchestrator.executeOnce(ctx);
  console.log(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
