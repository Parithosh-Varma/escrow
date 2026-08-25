const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer, treasury] = await hre.ethers.getSigners();

  if (!deployer) throw new Error("No deployer account found — check PRIVATE_KEY / hardhat accounts");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Deploying DecentralizedEscrow");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Network  :", hre.network.name);
  console.log("Deployer :", deployer.address);
  console.log("Balance  :", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  const defaultFeePercent = 100n; // 1% (100 bps)
  const treasuryAddress = process.env.TREASURY || deployer.address;

  if (treasuryAddress === hre.ethers.ZeroAddress) throw new Error("TREASURY is zero address");
  console.log("Treasury :", treasuryAddress);
  console.log("Fee      :", defaultFeePercent.toString(), "bps (1%)");

  console.log("\n→ Deploying DecentralizedEscrow...");
  const DecentralizedEscrow = await hre.ethers.getContractFactory("DecentralizedEscrow");
  const escrow = await DecentralizedEscrow.deploy(deployer.address, treasuryAddress, defaultFeePercent);
  await escrow.waitForDeployment();

  const escrowAddress = await escrow.getAddress();
  console.log("✓ DecentralizedEscrow deployed to:", escrowAddress);

  console.log("→ Deploying MockUSDC...");
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  console.log("✓ MockUSDC deployed to:", await usdc.getAddress());

  const deploymentInfo = {
    network: hre.network.name,
    chainId: hre.network.config.chainId,
    escrow: escrowAddress,
    usdc: await usdc.getAddress(),
    admin: deployer.address,
    treasury: treasuryAddress,
    defaultFeePercent: defaultFeePercent.toString(),
    timestamp: new Date().toISOString(),
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filePath = path.join(deploymentsDir, `${hre.network.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✓ Deployment info saved to:", filePath);
  console.log(JSON.stringify(deploymentInfo, null, 2));

  // Verify on Etherscan (skip on local/hardhat, skip if no API key)
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost" && process.env.ETHERSCAN_API_KEY) {
    console.log("\n→ Verifying on Etherscan...");
    try {
      await hre.run("verify:verify", {
        address: escrowAddress,
        constructorArguments: [deployer.address, treasuryAddress, defaultFeePercent],
      });
      console.log("✓ Verified on Etherscan");
    } catch (e) {
      console.log("⚠ Verification failed:", e.message);
    }
  } else {
    console.log("\n⊘ Etherscan verification skipped (local network or no API key)");
  }

  console.log("\nDone ✅");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
