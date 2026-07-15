/**
 * FundOS monitoring agent — read-only accounting, grant, yield, and lifecycle reporting.
 *
 * Required env:
 *   RPC_URL
 *   TREASURY_ADDRESS
 *   GRANT_CONTROLLER_ADDRESS
 *
 * Optional:
 *   JPYC_NETWORK (ethereum | polygon | avalanche, default: polygon)
 *   JPYC_TOKEN (optional assertion; must match TreasuryVault.jpyc())
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { resolveJPYCChain } from "./jpyc.js";

const treasuryAbi = parseAbi([
  "function jpyc() view returns (address)",
  "function protectedPrincipal() view returns (uint256)",
  "function availableGrantBudget() view returns (uint256)",
  "function totalTreasuryAssets() view returns (uint256)",
  "function accountingSurplus() view returns (uint256)",
  "function lifecycle() view returns (uint8)",
]);

const grantControllerAbi = parseAbi([
  "function nextProposalId() view returns (uint256)",
  "function getProposal(uint256 proposalId) view returns ((address recipient, uint256 amount, bytes32 purposeId, bytes32 evidenceHash, string metadataURI, uint64 createdAt, uint64 executableAt, uint64 expiresAt, uint8 approvalCount, uint8 status))",
  "function nextYieldAllocationId() view returns (uint256)",
  "function getYieldAllocation(uint256 allocationId) view returns ((uint256 amount, bytes32 evidenceHash, string metadataURI, address proposer, uint64 createdAt, uint64 executableAt, uint64 expiresAt, uint8 approvalCount, uint8 approvalThreshold, uint8 status))",
  "function getDissolution() view returns ((bytes32 resolutionHash, string metadataURI, address proposer, uint64 createdAt, uint64 executableAt, uint64 expiresAt, uint8 approvalCount, uint8 approvalThreshold, uint8 status))",
  "function reservedGrantBudget() view returns (uint256)",
  "function reservedYieldSurplus() view returns (uint256)",
  "function spendableGrantBudget() view returns (uint256)",
  "function spendableSurplus() view returns (uint256)",
  "function getPendingConfiguration() view returns ((uint256 maxGrantAmount, uint8 requiredApprovals, uint64 timelockDuration, uint64 proposalValidityPeriod, uint64 executableAt, bool pending))",
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

const GOVERNANCE_STATUS = {
  None: 0,
  Pending: 1,
  Approved: 2,
  Executed: 3,
  Cancelled: 4,
  Expired: 5,
} as const;

const FUND_LIFECYCLE = ["Active", "DissolutionPending", "Dissolved"] as const;

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

function governanceStatusName(status: number): keyof typeof GOVERNANCE_STATUS {
  const entry = Object.entries(GOVERNANCE_STATUS).find(([, value]) => value === status);
  return (entry?.[0] as keyof typeof GOVERNANCE_STATUS) ?? "None";
}

async function loadYieldAllocations(
  client: ReturnType<typeof createPublicClient>,
  controller: Address,
) {
  const nextId = await client.readContract({
    address: controller,
    abi: grantControllerAbi,
    functionName: "nextYieldAllocationId",
  });

  const allocations = [];
  for (let id = 1n; id < nextId; id++) {
    const allocation = await client.readContract({
      address: controller,
      abi: grantControllerAbi,
      functionName: "getYieldAllocation",
      args: [id],
    });
    allocations.push({
      allocationId: Number(id),
      amount: allocation.amount.toString(),
      evidenceHash: allocation.evidenceHash,
      metadataURI: allocation.metadataURI,
      proposer: allocation.proposer,
      createdAt: Number(allocation.createdAt),
      executableAt: Number(allocation.executableAt),
      expiresAt: Number(allocation.expiresAt),
      approvalCount: allocation.approvalCount,
      approvalThreshold: allocation.approvalThreshold,
      status: governanceStatusName(allocation.status),
    });
  }
  return allocations;
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

  const jpycAddress = await client.readContract({
    address: treasury,
    abi: treasuryAbi,
    functionName: "jpyc",
  });
  if (
    process.env.JPYC_TOKEN &&
    process.env.JPYC_TOKEN.toLowerCase() !== jpycAddress.toLowerCase()
  ) {
    throw new Error("JPYC_TOKEN does not match TreasuryVault.jpyc()");
  }

  const [
    jpycBalance,
    protectedPrincipal,
    availableGrantBudget,
    totalTreasuryAssets,
    accountingSurplus,
    lifecycle,
    dissolution,
    reservedGrantBudget,
    reservedYieldSurplus,
    spendableGrantBudget,
    spendableSurplus,
    pendingConfiguration,
  ] = await Promise.all([
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
      client.readContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "lifecycle",
      }),
      client.readContract({
        address: controller,
        abi: grantControllerAbi,
        functionName: "getDissolution",
      }),
      client.readContract({
        address: controller,
        abi: grantControllerAbi,
        functionName: "reservedGrantBudget",
      }),
      client.readContract({
        address: controller,
        abi: grantControllerAbi,
        functionName: "reservedYieldSurplus",
      }),
      client.readContract({
        address: controller,
        abi: grantControllerAbi,
        functionName: "spendableGrantBudget",
      }),
      client.readContract({
        address: controller,
        abi: grantControllerAbi,
        functionName: "spendableSurplus",
      }),
      client.readContract({
        address: controller,
        abi: grantControllerAbi,
        functionName: "getPendingConfiguration",
      }),
    ]);

  const proposals = await loadProposals(client, controller);
  const yieldAllocations = await loadYieldAllocations(client, controller);

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
  const reservationHolds =
    reservedGrantBudget <= availableGrantBudget && reservedYieldSurplus <= accountingSurplus;

  const report = {
    timestamp: new Date().toISOString(),
    treasury,
    grantController: controller,
    jpyc: jpycAddress,
    lifecycle: FUND_LIFECYCLE[lifecycle] ?? "Unknown",
    accounting: {
      jpycBalance: jpycBalance.toString(),
      protectedPrincipal: protectedPrincipal.toString(),
      availableGrantBudget: availableGrantBudget.toString(),
      reservedGrantBudget: reservedGrantBudget.toString(),
      spendableGrantBudget: spendableGrantBudget.toString(),
      totalTreasuryAssets: totalTreasuryAssets.toString(),
      accountingSurplus: accountingSurplus.toString(),
      reservedYieldSurplus: reservedYieldSurplus.toString(),
      spendableSurplus: spendableSurplus.toString(),
      invariantHolds,
      reservationHolds,
      invariant: "jpycBalance >= protectedPrincipal + availableGrantBudget",
      reservationInvariant:
        "reservedGrantBudget <= availableGrantBudget && reservedYieldSurplus <= accountingSurplus",
    },
    grants: {
      pending,
      approvedUnexecuted,
      executable,
      expired,
    },
    yieldAllocations,
    pendingConfiguration: {
      maxGrantAmount: pendingConfiguration.maxGrantAmount.toString(),
      requiredApprovals: pendingConfiguration.requiredApprovals,
      timelockDuration: Number(pendingConfiguration.timelockDuration),
      proposalValidityPeriod: Number(pendingConfiguration.proposalValidityPeriod),
      executableAt: Number(pendingConfiguration.executableAt),
      pending: pendingConfiguration.pending,
    },
    dissolution: {
      resolutionHash: dissolution.resolutionHash,
      metadataURI: dissolution.metadataURI,
      proposer: dissolution.proposer,
      createdAt: Number(dissolution.createdAt),
      executableAt: Number(dissolution.executableAt),
      expiresAt: Number(dissolution.expiresAt),
      approvalCount: dissolution.approvalCount,
      approvalThreshold: dissolution.approvalThreshold,
      status: governanceStatusName(dissolution.status),
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (!invariantHolds || !reservationHolds) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
