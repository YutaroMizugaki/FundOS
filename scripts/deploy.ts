import { ethers } from "hardhat";

/**
 * Deploys a full FundOS stack:
 *   1. A mock programmable-money asset (stand-in for a real stablecoin).
 *   2. A TimelockController that owns the fund, so any governance change
 *      (new strategy, new reserve ratio, pause/unpause) is delayed and
 *      publicly visible before it takes effect.
 *   3. The FundVault itself (ERC4626 vault around the asset).
 *   4. A StreamingDistributionStrategy wired up with example beneficiaries.
 *
 * NOTE: because the vault/strategy owner is the Timelock, actually calling
 * `setStrategy`/`setBeneficiaries` afterwards requires going through
 * `timelock.schedule(...)` and, once `minDelay` has elapsed,
 * `timelock.execute(...)` — a single EOA can no longer flip these settings
 * instantly.
 */
async function main() {
  const [deployer, beneficiary1, beneficiary2] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const asset = await MockERC20.deploy("Programmable USD", "pUSD", 18);
  await asset.waitForDeployment();

  const minDelay = 60 * 60 * 24; // 24h governance delay
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(
    minDelay,
    [deployer.address], // proposers
    [deployer.address], // executors
    deployer.address, // admin (should be renounced/transferred to a DAO in production)
  );
  await timelock.waitForDeployment();

  const FundVault = await ethers.getContractFactory("FundVault");
  const vault = await FundVault.deploy(
    await asset.getAddress(),
    "FundOS Autonomous Vault",
    "fosUSD",
    await timelock.getAddress(),
  );
  await vault.waitForDeployment();

  const Strategy = await ethers.getContractFactory("StreamingDistributionStrategy");
  const strategy = await Strategy.deploy(await timelock.getAddress(), 60 * 60, [
    { account: beneficiary1.address, weightBps: 6000 },
    { account: beneficiary2.address, weightBps: 4000 },
  ]);
  await strategy.waitForDeployment();

  console.log("Programmable money asset (pUSD):", await asset.getAddress());
  console.log("Governance TimelockController:  ", await timelock.getAddress());
  console.log("FundVault:                      ", await vault.getAddress());
  console.log("StreamingDistributionStrategy:  ", await strategy.getAddress());
  console.log(
    "\nFundVault.setStrategy(...) must be scheduled and executed through the Timelock " +
      "(schedule -> wait minDelay -> execute) since the Timelock is the vault owner.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
