import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Demonstrates the intended governance model: the FundVault's owner is a
 * TimelockController, so changing the strategy (or any other onlyOwner
 * setting) cannot happen instantly from a single key — it must be scheduled
 * and can only be executed after `minDelay` has passed.
 */
describe("Governance via TimelockController", () => {
  const MIN_DELAY = 3600; // 1 hour

  async function deployFixture() {
    const [admin, depositor, beneficiary] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const asset = await MockERC20.deploy("Programmable USD", "pUSD", 18);

    const TimelockController = await ethers.getContractFactory("TimelockController");
    const timelock = await TimelockController.deploy(MIN_DELAY, [admin.address], [admin.address], admin.address);

    const FundVault = await ethers.getContractFactory("FundVault");
    const vault = await FundVault.deploy(
      await asset.getAddress(),
      "FundOS Autonomous Vault",
      "fosUSD",
      await timelock.getAddress(),
    );

    const Strategy = await ethers.getContractFactory("StreamingDistributionStrategy");
    const strategy = await Strategy.deploy(await timelock.getAddress(), 3600, [
      { account: beneficiary.address, weightBps: 10000 },
    ]);

    return { admin, depositor, beneficiary, asset, timelock, vault, strategy };
  }

  it("prevents the admin from calling setStrategy directly on the vault", async () => {
    const { admin, vault, strategy } = await deployFixture();
    await expect(vault.connect(admin).setStrategy(await strategy.getAddress())).to.be.revertedWithCustomError(
      vault,
      "OwnableUnauthorizedAccount",
    );
  });

  it("allows setStrategy only after scheduling through the timelock and waiting minDelay", async () => {
    const { admin, vault, timelock, strategy } = await deployFixture();

    const target = await vault.getAddress();
    const data = vault.interface.encodeFunctionData("setStrategy", [await strategy.getAddress()]);
    const salt = ethers.id("set-initial-strategy");

    await timelock.connect(admin).schedule(target, 0, data, ethers.ZeroHash, salt, MIN_DELAY);

    // Executing too early must fail.
    await expect(
      timelock.connect(admin).execute(target, 0, data, ethers.ZeroHash, salt),
    ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

    await time.increase(MIN_DELAY + 1);

    await timelock.connect(admin).execute(target, 0, data, ethers.ZeroHash, salt);
    expect(await vault.strategy()).to.equal(await strategy.getAddress());
  });
});
