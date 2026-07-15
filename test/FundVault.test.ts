import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { FundVault, MockERC20, StreamingDistributionStrategy } from "../typechain-types";

describe("FundVault", () => {
  const ONE = ethers.parseUnits("1", 18);

  async function deployFixture() {
    const [owner, depositor, beneficiary1, beneficiary2, keeper, stranger] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const asset = (await MockERC20.deploy("Programmable USD", "pUSD", 18)) as unknown as MockERC20;

    const FundVault = await ethers.getContractFactory("FundVault");
    const vault = (await FundVault.deploy(
      await asset.getAddress(),
      "FundOS Autonomous Vault",
      "fosUSD",
      owner.address,
    )) as unknown as FundVault;

    const Strategy = await ethers.getContractFactory("StreamingDistributionStrategy");
    const strategy = (await Strategy.deploy(owner.address, 3600, [
      { account: beneficiary1.address, weightBps: 6000 },
      { account: beneficiary2.address, weightBps: 4000 },
    ])) as unknown as StreamingDistributionStrategy;

    await vault.connect(owner).setStrategy(await strategy.getAddress());

    await asset.mint(depositor.address, ethers.parseUnits("1000", 18));
    await asset.connect(depositor).approve(await vault.getAddress(), ethers.MaxUint256);

    return { owner, depositor, beneficiary1, beneficiary2, keeper, stranger, asset, vault, strategy };
  }

  describe("deposits & withdrawals", () => {
    it("mints shares 1:1 on first deposit and tracks totalAssets", async () => {
      const { depositor, vault } = await deployFixture();

      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);

      expect(await vault.balanceOf(depositor.address)).to.equal(ethers.parseUnits("100", 18));
      expect(await vault.totalAssets()).to.equal(ethers.parseUnits("100", 18));
    });

    it("allows a depositor to redeem their shares back for the underlying asset", async () => {
      const { depositor, asset, vault } = await deployFixture();

      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);
      const shares = await vault.balanceOf(depositor.address);

      const before = await asset.balanceOf(depositor.address);
      await vault.connect(depositor).redeem(shares, depositor.address, depositor.address);
      const after = await asset.balanceOf(depositor.address);

      expect(after - before).to.equal(ethers.parseUnits("100", 18));
      expect(await vault.balanceOf(depositor.address)).to.equal(0);
    });
  });

  describe("idleAssets / reserve ratio", () => {
    it("holds back reserveRatioBps of the balance by default (20%)", async () => {
      const { depositor, vault } = await deployFixture();
      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);

      expect(await vault.idleAssets()).to.equal(ethers.parseUnits("80", 18));
    });

    it("lets the owner change the reserve ratio", async () => {
      const { owner, depositor, vault } = await deployFixture();
      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);

      await vault.connect(owner).setReserveRatioBps(5000);
      expect(await vault.idleAssets()).to.equal(ethers.parseUnits("50", 18));
    });

    it("reverts if a non-owner tries to change the reserve ratio", async () => {
      const { stranger, vault } = await deployFixture();
      await expect(vault.connect(stranger).setReserveRatioBps(0)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("reverts if the reserve ratio is set above 100%", async () => {
      const { owner, vault } = await deployFixture();
      await expect(vault.connect(owner).setReserveRatioBps(10_001)).to.be.revertedWithCustomError(
        vault,
        "InvalidRatio",
      );
    });
  });

  describe("autoExecute — permissionless autonomous distribution", () => {
    it("can be triggered by anyone, not just the owner", async () => {
      const { depositor, keeper, beneficiary1, beneficiary2, asset, vault } = await deployFixture();
      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);

      await expect(vault.connect(keeper).autoExecute()).to.not.be.reverted;

      // idle = 80 pUSD -> 60% / 40% split
      expect(await asset.balanceOf(beneficiary1.address)).to.equal(ethers.parseUnits("48", 18));
      expect(await asset.balanceOf(beneficiary2.address)).to.equal(ethers.parseUnits("32", 18));
    });

    it("emits AutoExecuted with the keeper address and amounts", async () => {
      const { depositor, keeper, vault } = await deployFixture();
      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);

      const tx = await vault.connect(keeper).autoExecute();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(vault, "AutoExecuted")
        .withArgs(keeper.address, ethers.parseUnits("80", 18), ethers.parseUnits("80", 18), block!.timestamp);
    });

    it("reverts with StrategyNotDue if called again before minInterval elapses", async () => {
      const { depositor, keeper, vault } = await deployFixture();
      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);

      await vault.connect(keeper).autoExecute();
      await expect(vault.connect(keeper).autoExecute()).to.be.revertedWithCustomError(vault, "StrategyNotDue");
    });

    it("succeeds again once minInterval has elapsed and new idle assets accrued", async () => {
      const { depositor, keeper, vault, asset } = await deployFixture();
      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);
      await vault.connect(keeper).autoExecute();

      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);
      await time.increase(3601);

      await expect(vault.connect(keeper).autoExecute()).to.not.be.reverted;
    });

    it("reverts with NoStrategySet if no strategy has been configured", async () => {
      const [owner, depositor] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const asset = await MockERC20.deploy("Programmable USD", "pUSD", 18);
      const FundVault = await ethers.getContractFactory("FundVault");
      const vault = await FundVault.deploy(await asset.getAddress(), "FundOS Autonomous Vault", "fosUSD", owner.address);

      await asset.mint(depositor.address, ONE);
      await asset.connect(depositor).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(depositor).deposit(ONE, depositor.address);

      await expect(vault.autoExecute()).to.be.revertedWithCustomError(vault, "NoStrategySet");
    });

    it("respects pause/unpause", async () => {
      const { owner, depositor, keeper, vault } = await deployFixture();
      await vault.connect(depositor).deposit(ethers.parseUnits("100", 18), depositor.address);

      await vault.connect(owner).pause();
      await expect(vault.connect(keeper).autoExecute()).to.be.revertedWithCustomError(vault, "EnforcedPause");

      await vault.connect(owner).unpause();
      await expect(vault.connect(keeper).autoExecute()).to.not.be.reverted;
    });
  });

  describe("strategy governance", () => {
    it("only the owner can change the strategy", async () => {
      const { stranger, vault } = await deployFixture();
      await expect(vault.connect(stranger).setStrategy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("emits StrategyUpdated when the strategy changes", async () => {
      const { owner, vault, strategy } = await deployFixture();
      const strategyAddr = await strategy.getAddress();
      await expect(vault.connect(owner).setStrategy(ethers.ZeroAddress))
        .to.emit(vault, "StrategyUpdated")
        .withArgs(strategyAddr, ethers.ZeroAddress);
    });
  });
});
