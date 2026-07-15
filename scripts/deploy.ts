import { ethers } from "hardhat";

/**
 * Deploy FundPolicy + FundVault for local / testnet bootstrap.
 * Executor should be the autonomous agent (or a keeper) key.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const categories = [
    ethers.encodeBytes32String("climate"),
    ethers.encodeBytes32String("public-goods"),
    ethers.encodeBytes32String("education"),
    ethers.encodeBytes32String("research"),
  ];

  const Policy = await ethers.getContractFactory("FundPolicy");
  const policy = await Policy.deploy(
    500, // 5%
    2000, // 20%
    categories,
    deployer.address,
  );
  await policy.waitForDeployment();

  const Vault = await ethers.getContractFactory("FundVault");
  const vault = await Vault.deploy(await policy.getAddress(), deployer.address);
  await vault.waitForDeployment();

  console.log("FundPolicy:", await policy.getAddress());
  console.log("FundVault:", await vault.getAddress());
  console.log("Guardian/Executor:", deployer.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
