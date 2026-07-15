import type { Address } from "viem";
import { avalanche, mainnet, polygon } from "viem/chains";

/** JPYC: 1 token = 1 yen, 18 decimals (ERC-20). */
export const JPYC_DECIMALS = 18;

/** Canonical JPYC v2 address (Ethereum / Polygon / Avalanche). */
export const JPYC_ADDRESS =
  "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29" as const satisfies Address;

export const JPYC_CHAINS = {
  ethereum: mainnet,
  polygon,
  avalanche,
} as const;

export type JPYCNetwork = keyof typeof JPYC_CHAINS;

export function resolveJPYCChain(network: string) {
  const key = network.toLowerCase() as JPYCNetwork;
  const chain = JPYC_CHAINS[key];
  if (!chain) {
    throw new Error(`Unsupported JPYC network: ${network}. Use ethereum | polygon | avalanche`);
  }
  return chain;
}

/** Whole-yen amount → on-chain units (18 decimals). */
export function yen(wholeYen: number | bigint): bigint {
  return BigInt(wholeYen) * 10n ** BigInt(JPYC_DECIMALS);
}

/** On-chain units → whole yen (floor). */
export function formatYen(amount: bigint): string {
  const whole = amount / 10n ** BigInt(JPYC_DECIMALS);
  return `${whole.toLocaleString("ja-JP")} 円`;
}

/** Default policy for a JPYC-denominated autonomous fund. */
export const DEFAULT_JPYC_POLICY = {
  minCashReserveBps: 1000,
  maxTransferBps: 2000,
  dailySpendCapYen: 10_000_000n,
  targetCashBps: 2000,
} as const;
