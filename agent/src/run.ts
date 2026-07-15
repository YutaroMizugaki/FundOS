/**
 * 高専支援基金エージェント — 余剰 JPYC を利回り先へ送るだけの最小ループ。
 *
 * 環境変数:
 *   RPC_URL, FUND_ADDRESS, EXECUTOR_PRIVATE_KEY
 *   TARGET_CASH_BPS (default 2000) — この比率を超える現金を利回りへ
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveJPYCChain } from "./jpyc.js";

const fundAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
  "function minCashReserveBps() view returns (uint16)",
  "function deployYield(uint256 amount)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const network = env("JPYC_NETWORK", "polygon");
  const chain = resolveJPYCChain(network);
  const fundAddress = env("FUND_ADDRESS") as Address;
  const account = privateKeyToAccount(env("EXECUTOR_PRIVATE_KEY") as Hex);
  const targetCashBps = Number(env("TARGET_CASH_BPS", "2000"));

  const publicClient = createPublicClient({ chain, transport: http(env("RPC_URL")) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(env("RPC_URL")),
  });

  const [totalAssets, baseAsset, minReserveBps] = await Promise.all([
    publicClient.readContract({ address: fundAddress, abi: fundAbi, functionName: "totalAssets" }),
    publicClient.readContract({ address: fundAddress, abi: fundAbi, functionName: "asset" }),
    publicClient.readContract({
      address: fundAddress,
      abi: fundAbi,
      functionName: "minCashReserveBps",
    }),
  ]);

  const cash = await publicClient.readContract({
    address: baseAsset,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [fundAddress],
  });

  const targetCash = (totalAssets * BigInt(targetCashBps)) / 10_000n;
  const minCash = (totalAssets * BigInt(minReserveBps)) / 10_000n;
  let deployAmount = cash > targetCash ? cash - targetCash : 0n;
  const maxDeploy = cash > minCash ? cash - minCash : 0n;
  if (deployAmount > maxDeploy) deployAmount = maxDeploy;

  if (deployAmount <= 0n) {
    console.log(JSON.stringify({ action: "skip", reason: "no excess JPYC", cash: cash.toString() }));
    return;
  }

  const hash = await walletClient.writeContract({
    account,
    chain,
    address: fundAddress,
    abi: fundAbi,
    functionName: "deployYield",
    args: [deployAmount],
  });

  console.log(
    JSON.stringify({
      action: "deployYield",
      amount: deployAmount.toString(),
      txHash: hash,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
