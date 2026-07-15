# FundOS — Programmable Money, Self-Driving Fund

FundOS is an on-chain autonomous fund protocol built in Solidity.  Depositors
lock capital in an **ERC-4626 vault** and receive fungible **FUND** share
tokens.  The vault delegates all capital to a **FundManager** which
autonomously allocates across pluggable yield **Strategies**, collects
fees, and rebalances positions — no human custodian required.

---

## Architecture

```
Depositors
    │  deposit(assets) / redeem(shares)
    ▼
┌─────────────────────────────────────┐
│          FundVault (ERC-4626)        │  ← FUND share token
│  • totalAssets = vault idle          │
│              + manager.totalAssets() │
│  • management fee (time-weighted)    │
│  • performance fee (high-water mark) │
└──────────────┬──────────────────────┘
               │ deployCapital / withdrawCapital
               ▼
┌─────────────────────────────────────┐
│            FundManager              │  ← autonomous allocator
│  • strategy registry (≤ 20)         │
│  • target allocations in BPS        │
│  • rebalance() — permissionless     │
│  • harvestAll() — permissionless    │
└──────┬──────────────┬───────────────┘
       │              │
       ▼              ▼
 YieldStrategy   (more strategies…)    ← IStrategy implementations
 BaseStrategy

┌─────────────────────────────────────┐
│          FundGovernance             │  ← on-chain voting
│  • FUND holders propose & vote      │
│  • quorum + majority thresholds     │
│  • timelock before execution        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│          FeeDistributor             │  ← fee routing
│  • receives treasury shares         │
│  • distributes by weight to         │
│    protocol / strategist / stakers  │
└─────────────────────────────────────┘
```

---

## Contracts

| Contract | Description |
|---|---|
| `src/FundVault.sol` | ERC-4626 vault.  Issues FUND shares; collects management & performance fees. |
| `src/FundManager.sol` | Autonomous capital allocator.  Holds idle liquidity; deploys into strategies. |
| `src/interfaces/IStrategy.sol` | Strategy interface: `deposit`, `withdraw`, `harvest`, `emergencyExit`. |
| `src/interfaces/IFundManager.sol` | Manager interface consumed by vault and governance. |
| `src/strategies/BaseStrategy.sol` | Abstract base for strategies.  Handles access control and lifecycle. |
| `src/strategies/YieldStrategy.sol` | Demo strategy simulating continuous yield accrual. |
| `src/FundGovernance.sol` | On-chain governance with proposal → vote → timelock → execute flow. |
| `src/FeeDistributor.sol` | Routes accumulated fee shares to configurable recipients by weight. |
| `src/mocks/MockERC20.sol` | Mintable ERC-20 for testing only. |
| `script/Deploy.s.sol` | Full deployment script (configurable via env vars). |

---

## Key Mechanisms

### Share Price

```
sharePrice = totalAssets() / totalSupply()
totalAssets = vault.idleBalance + fundManager.totalAssets()
            = vault.idleBalance + manager.idleBalance + Σ strategy.totalAssets()
```

Share price continuously reflects real-time strategy P&L.

### Management Fee

Charged as a time-weighted dilution of existing holders:

```
feeShares = totalSupply × feeBps/10000 × elapsed/SECONDS_PER_YEAR
```

New shares are minted to the treasury on each deposit, withdrawal, or
explicit harvest.

### Performance Fee

Charged only when `totalAssets` exceeds the **high-water mark**:

```
feeAssets = (totalAssets − highWaterMark) × perfFeeBps / 10000
feeShares = convertToShares(feeAssets)
```

New shares are minted to the treasury; the high-water mark advances.

### Rebalancing

`FundManager.rebalance()` is **permissionless** — any keeper (Chainlink
Automation, Gelato, custom script) can trigger it.

```
for each strategy:
  target  = totalAssets × targetBps / 10000
  current = strategy.totalAssets()
  if |current − target| / totalAssets ≥ THRESHOLD (1%):
    deposit or withdraw the delta
```

### Autonomous Harvest

`FundManager.harvestAll()` is also permissionless.  It calls `harvest()` on
every active strategy, collects yield into the manager, and increments
`totalAssets`.  `FundVault.harvest()` wraps this and applies the performance
fee if a new high-water mark is reached.

### Governance

1. Any FUND holder **proposes** (type + ABI-encoded params + description).
2. Holders **vote** for/against using their current balance as weight.
3. After the voting window, anyone calls `queue()`.  If quorum + majority
   reached → Queued; otherwise → Defeated.
4. After the **timelock delay**, anyone calls `execute()` which dispatches
   directly to FundManager.

Supported proposal types: `ADD_STRATEGY`, `REMOVE_STRATEGY`,
`UPDATE_ALLOCATION`.

---

## Getting Started

### Prerequisites

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Build

```bash
forge build
```

### Test

```bash
forge test -v
```

### Deploy (local Anvil)

```bash
# Start local node
anvil &

# Export required vars
export DEPLOYER_KEY=<anvil-private-key>
export ASSET=<ERC20-address>
export TREASURY=<treasury-address>

forge script script/Deploy.s.sol --broadcast --rpc-url http://localhost:8545
```

---

## Writing a Custom Strategy

1. Inherit `BaseStrategy`.
2. Implement `_deposit`, `_withdraw`, `_harvest`, `_totalAssets`.
3. Optionally override `_emergencyExit` to liquidate external positions.

```solidity
contract MyStrategy is BaseStrategy {
    constructor(address asset, address manager)
        BaseStrategy(asset, manager, "MyStrategy") {}

    function _deposit(uint256 amount) internal override { /* deploy to protocol */ }
    function _withdraw(uint256 amount) internal override { /* redeem from protocol */ }
    function _harvest() internal override returns (uint256) { /* collect yield */ }
    function _totalAssets() internal view override returns (uint256) { /* report NAV */ }
}
```

Register via governance:

```solidity
governance.propose(
    FundGovernance.ProposalType.ADD_STRATEGY,
    abi.encode(address(myStrategy), uint16(3000)), // 30% allocation
    "Add MyStrategy at 30%"
);
```

---

## Security Notes

- FundManager ownership is transferred to FundGovernance after deploy — no
  single key can change allocations.
- Emergency pause on both vault and manager prevents new deposits/rebalances
  while allowing existing holders to exit.
- `emergencyExit()` on a strategy liquidates all positions and returns assets
  to the manager without going through normal withdrawal queues.
- Strategy contracts are isolated — one strategy's failure cannot drain
  another's assets.
- All external calls use OpenZeppelin's `SafeERC20` and `ReentrancyGuard`.

---

## License

MIT
