import { expect } from "chai";
import { ethers } from "hardhat";

describe("StreamingDistributionStrategy", () => {
  async function deployFixture() {
    const [owner, beneficiary1, beneficiary2, other] = await ethers.getSigners();

    const Strategy = await ethers.getContractFactory("StreamingDistributionStrategy");
    const strategy = await Strategy.deploy(owner.address, 3600, [
      { account: beneficiary1.address, weightBps: 6000 },
      { account: beneficiary2.address, weightBps: 4000 },
    ]);

    return { owner, beneficiary1, beneficiary2, other, strategy };
  }

  it("rejects construction/config where weights don't sum to 10000", async () => {
    const [owner, b1, b2] = await ethers.getSigners();
    const Strategy = await ethers.getContractFactory("StreamingDistributionStrategy");

    await expect(
      Strategy.deploy(owner.address, 3600, [
        { account: b1.address, weightBps: 5000 },
        { account: b2.address, weightBps: 4000 },
      ]),
    ).to.be.revertedWithCustomError(Strategy, "WeightsMustSumTo10000");
  });

  it("rejects an empty beneficiary list", async () => {
    const [owner] = await ethers.getSigners();
    const Strategy = await ethers.getContractFactory("StreamingDistributionStrategy");
    await expect(Strategy.deploy(owner.address, 3600, [])).to.be.revertedWithCustomError(
      Strategy,
      "EmptyBeneficiaries",
    );
  });

  it("rejects a zero address beneficiary", async () => {
    const [owner, b1] = await ethers.getSigners();
    const Strategy = await ethers.getContractFactory("StreamingDistributionStrategy");
    await expect(
      Strategy.deploy(owner.address, 3600, [
        { account: ethers.ZeroAddress, weightBps: 6000 },
        { account: b1.address, weightBps: 4000 },
      ]),
    ).to.be.revertedWithCustomError(Strategy, "ZeroAddress");
  });

  it("only the owner can reconfigure beneficiaries", async () => {
    const { other, beneficiary1, beneficiary2, strategy } = await deployFixture();
    await expect(
      strategy.connect(other).setBeneficiaries([{ account: beneficiary1.address, weightBps: 10000 }]),
    ).to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    void beneficiary2;
  });

  it("shouldExecute is false with zero idle assets or before minInterval elapses", async () => {
    const { strategy } = await deployFixture();
    expect(await strategy.shouldExecute(0, 0)).to.equal(false);
    expect(await strategy.shouldExecute(1000, (await ethers.provider.getBlock("latest"))!.timestamp)).to.equal(
      false,
    );
  });

  it("reports the configured beneficiaries and their weights", async () => {
    const { beneficiary1, beneficiary2, strategy } = await deployFixture();
    const list = await strategy.beneficiaries();
    expect(list.length).to.equal(2);
    expect(list[0].account).to.equal(beneficiary1.address);
    expect(list[0].weightBps).to.equal(6000);
    expect(list[1].account).to.equal(beneficiary2.address);
    expect(list[1].weightBps).to.equal(4000);
  });
});
