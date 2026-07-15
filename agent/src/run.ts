/**
 * FundOS Phase 1 monitoring agent — read-only fund health and grant pipeline reporting.
 *
 * Required env:
 *   RPC_URL
 *   TREASURY_ADDRESS
 *   GRANT_CONTROLLER_ADDRESS
 *
 * Optional:
 *   JPYC_NETWORK (ethereum | polygon | avalanche, default: polygon)
 *   JPYC_TOKEN (override token address; defaults to canonical JPYC)
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { resolveJPYCChain, JPYC_ADDRESS } from "./jpyc.js";

const treasuryAbi = parseAbi([
  "function jpyc() view returns (address)",
  "function protectedPrincipal() view returns (uint256)",
  "function availableGrantBudget() view returns (uint256)",
  "function totalTreasuryAssets() view returns (uint256)",
  "function accountingSurplus() view returns (uint256)",
]);

const grantControllerAbi = parseAbi([
  "function nextProposalId() view returns (uint256)",
  "function getProposal(uint256 proposalId) view returns ((address recipient, uint256 amount, bytes32 purposeId, bytes32 evidenceHash, string metadataURI, uint64 createdAt, uint64 executableAt, uint64 expiresAt, uint8 approvalCount, uint8 status))",
]);

const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

const GRANT_STATUS = {
  None: 0,
  Pending: 1,
  Approved: 2,
  Executed: 3,
  Cancelled: 4,
  Expired: 5,
} as const;

type GrantProposal = {
  proposalId: number;
  recipient: Address;
  amount: string;
  purposeId: `0x${string}`;
  evidenceHash: `0x${string}`;
  metadataURI: string;
  createdAt: number;
  executableAt: number;
  expiresAt: number;
  approvalCount: number;
  status: keyof typeof GRANT_STATUS;
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function statusName(status: number): keyof typeof GRANT_STATUS {
  const entry = Object.entries(GRANT_STATUS).find(([, value]) => value === status);
  return (entry?.[0] as keyof typeof GRANT_STATUS) ?? "None";
}

async function loadProposals(
  client: ReturnType<typeof createPublicClient>,
  controller: Address,
): Promise<GrantProposal[]> {
  const nextId = await client.readContract({
    address: controller,
    abi: grantControllerAbi,
    functionName: "nextProposalId",
  });

  const proposals: GrantProposal[] = [];
  for (let id = 1n; id < nextId; id++) {
    const proposal = await client.readContract({
      address: controller,
      abi: grantControllerAbi,
      functionName: "getProposal",
      args: [id],
    });

    if (proposal.status === GRANT_STATUS.None) continue;

    proposals.push({
      proposalId: Number(id),
      recipient: proposal.recipient,
      amount: proposal.amount.toString(),
      purposeId: proposal.purposeId,
      evidenceHash: proposal.evidenceHash,
      metadataURI: proposal.metadataURI,
      createdAt: Number(proposal.createdAt),
      executableAt: Number(proposal.executableAt),
      expiresAt: Number(proposal.expiresAt),
      approvalCount: proposal.approvalCount,
      status: statusName(proposal.status),
    });
  }

  return proposals;
}

async function main() {
  const network = process.env.JPYC_NETWORK ?? "polygon";
  const chain = resolveJPYCChain(network);
  const treasury = env("TREASURY_ADDRESS") as Address;
  const controller = env("GRANT_CONTROLLER_ADDRESS") as Address;

  const client = createPublicClient({ chain, transport: http(env("RPC_URL")) });
  const now = Math.floor(Date.now() / 1000);

  const jpycAddress = (process.env.JPYC_TOKEN ?? JPYC_ADDRESS) as Address;

  const [jpycBalance, protectedPrincipal, availableGrantBudget, totalTreasuryAssets, accountingSurplus] =
    await Promise.all([
      client.readContract({
        address: jpycAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [treasury],
      }),
      client.readContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "protectedPrincipal",
      }),
      client.readContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "availableGrantBudget",
      }),
      client.readContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "totalTreasuryAssets",
      }),
      client.readContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "accountingSurplus",
      }),
    ]);

  const proposals = await loadProposals(client, controller);

  const pending = proposals.filter((p) => p.status === "Pending");
  const approvedUnexecuted = proposals.filter((p) => p.status === "Approved");
  const executable = approvedUnexecuted.filter((p) => p.executableAt > 0 && p.executableAt <= now);
  const expired = proposals.filter(
    (p) =>
      (p.status === "Pending" || p.status === "Approved") &&
      p.expiresAt > 0 &&
      p.expiresAt < now,
  );

  const accounted = protectedPrincipal + availableGrantBudget;
  const invariantHolds = jpycBalance >= accounted;

  const report = {
    timestamp: new Date().toISOString(),
    treasury,
    grantController: controller,
    jpyc: jpycAddress,
    accounting: {
      jpycBalance: jpycBalance.toString(),
      protectedPrincipal: protectedPrincipal.toString(),
      availableGrantBudget: availableGrantBudget.toString(),
      totalTreasuryAssets: totalTreasuryAssets.toString(),
      accountingSurplus: accountingSurplus.toString(),
      invariantHolds,
      invariant: "jpycBalance >= protectedPrincipal + availableGrantBudget",
    },
    grants: {
      pending,
      approvedUnexecuted,
      executable,
      expired,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (!invariantHolds) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
