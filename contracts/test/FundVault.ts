import { expect } from "chai";
import { ethers } from "hardhat";

describe("FundVault + FundPolicy (on-chain autonomous fund)", function () {
  async function deployFixture() {
    const [guardian, executor, alice, bob] = await ethers.getSigners();

    const climate = ethers.encodeBytes32String("climate");
    const publicGoods = ethers.encodeBytes32String("public-goods");
    const marketing = ethers.encodeBytes32String("marketing");

    const Policy = await ethers.getContractFactory("FundPolicy");
    const policy = await Policy.deploy(
      500, // 5% max disbursement
      2000, // 20% reserve floor
      [climate, publicGoods],
      guardian.address,
    );

    const Vault = await ethers.getContractFactory("FundVault");
    const vault = await Vault.deploy(await policy.getAddress(), executor.address);

    await vault.connect(alice).deposit({ value: ethers.parseEther("100") });

    return { policy, vault, guardian, executor, alice, bob, climate, publicGoods, marketing };
  }

  it("locks reserve floor on deposit", async function () {
    const { vault } = await deployFixture();
    expect(await vault.nav()).to.equal(ethers.parseEther("100"));
    expect(await vault.reserved()).to.equal(ethers.parseEther("20"));
    expect(await vault.cash()).to.equal(ethers.parseEther("80"));
  });

  it("executor autonomously disburses when policy passes", async function () {
    const { vault, executor, bob, climate } = await deployFixture();

    const amount = ethers.parseEther("4");
    await vault.connect(bob).submitProposal(bob.address, amount, climate, "sensor grant");

    const before = await ethers.provider.getBalance(bob.address);
    await vault.connect(executor).executeProposal(0);
    const after = await ethers.provider.getBalance(bob.address);
    expect(after - before).to.equal(amount);
    expect(await vault.totalOutflows()).to.equal(amount);
  });

  it("rejects out-of-mandate category and over-cap amounts", async function () {
    const { vault, executor, bob, marketing, climate } = await deployFixture();

    await vault
      .connect(bob)
      .submitProposal(bob.address, ethers.parseEther("1"), marketing, "ads");
    await expect(vault.connect(executor).executeProposal(0)).to.be.revertedWithCustomError(
      vault,
      "PolicyRejected",
    );

    await vault
      .connect(bob)
      .submitProposal(bob.address, ethers.parseEther("10"), climate, "too big");
    await expect(vault.connect(executor).executeProposal(1)).to.be.revertedWithCustomError(
      vault,
      "PolicyRejected",
    );
  });

  it("non-executor cannot execute", async function () {
    const { vault, bob, climate } = await deployFixture();
    await vault
      .connect(bob)
      .submitProposal(bob.address, ethers.parseEther("1"), climate, "ok");
    await expect(vault.connect(bob).executeProposal(0)).to.be.revertedWithCustomError(
      vault,
      "NotExecutor",
    );
  });
});
