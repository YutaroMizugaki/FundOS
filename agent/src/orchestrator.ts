import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { ExecutionResult, PolicySnapshot, StrategyContext, TransferProposal } from "./types.js";
import { TargetWeightStrategy } from "./strategy.js";

const vaultAbi = [
  {
    name: "executeManagedTransfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "reasonHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const policyAbi = [
  {
    name: "policy",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "minCashReserveBps", type: "uint16" },
          { name: "maxTransferBps", type: "uint16" },
          { name: "dailySpendCap", type: "uint256" },
          { name: "autonomousMode", type: "bool" },
        ],
      },
    ],
  },
  {
    name: "dailySpendToday",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface AgentConfig {
  rpcUrl: string;
  vaultAddress: Address;
  policyAddress: Address;
  executorPrivateKey: Hex;
  yieldSink: Address;
}

export class FundAgentOrchestrator {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly strategy: TargetWeightStrategy;

  constructor(private readonly config: AgentConfig) {
    const account = privateKeyToAccount(config.executorPrivateKey);
    this.publicClient = createPublicClient({ chain: foundry, transport: http(config.rpcUrl) });
    this.walletClient = createWalletClient({
      account,
      chain: foundry,
      transport: http(config.rpcUrl),
    });
    this.strategy = new TargetWeightStrategy(config.yieldSink);
  }

  async readPolicySnapshot(): Promise<PolicySnapshot> {
    const [policy, dailySpendToday, totalAssets, baseAsset] = await Promise.all([
      this.publicClient.readContract({
        address: this.config.policyAddress,
        abi: policyAbi,
        functionName: "policy",
      }),
      this.publicClient.readContract({
        address: this.config.policyAddress,
        abi: policyAbi,
        functionName: "dailySpendToday",
      }),
      this.publicClient.readContract({
        address: this.config.vaultAddress,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      this.publicClient.readContract({
        address: this.config.vaultAddress,
        abi: vaultAbi,
        functionName: "asset",
      }),
    ]);

    const cashBalance = await this.publicClient.readContract({
      address: baseAsset,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.config.vaultAddress],
    });

    return {
      autonomousMode: policy.autonomousMode,
      minCashReserveBps: policy.minCashReserveBps,
      maxTransferBps: policy.maxTransferBps,
      dailySpendCap: policy.dailySpendCap,
      dailySpendToday,
      totalAssets,
      cashBalance,
    };
  }

  propose(ctx: StrategyContext): Promise<TransferProposal | null> {
    return this.readPolicySnapshot().then((policy) => this.strategy.propose(ctx, policy));
  }

  reasonHash(ctx: StrategyContext): Hash {
    return keccak256(toBytes(JSON.stringify(ctx)));
  }

  async executeOnce(ctx: StrategyContext): Promise<ExecutionResult> {
    const policy = await this.readPolicySnapshot();

    if (!policy.autonomousMode) {
      return {
        proposal: { asset: "0x0", to: "0x0", amount: 0n, reason: "autonomous mode disabled" },
        reasonHash: this.reasonHash(ctx),
        executed: false,
        rejectionReason: "autonomous mode disabled",
      };
    }

    const proposal = this.strategy.propose(ctx, policy);
    if (!proposal) {
      return {
        proposal: { asset: "0x0", to: "0x0", amount: 0n, reason: "no action" },
        reasonHash: this.reasonHash(ctx),
        executed: false,
        rejectionReason: "no rebalance needed",
      };
    }

    const hash = this.reasonHash(ctx);
    const txHash = await this.walletClient.writeContract({
      account: this.walletClient.account!,
      chain: foundry,
      address: this.config.vaultAddress,
      abi: vaultAbi,
      functionName: "executeManagedTransfer",
      args: [proposal.asset, proposal.to, proposal.amount, hash],
    });

    return { proposal, reasonHash: hash, executed: true, txHash };
  }
}
