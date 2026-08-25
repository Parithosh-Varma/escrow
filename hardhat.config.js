require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config();

// Optional plugins — wrapped to stay compatible with Node 24 / Hardhat 2.22
try { require("@nomicfoundation/hardhat-verify"); } catch (e) { /* verify optional */ }
try { require("hardhat-gas-reporter"); } catch (e) { /* gas reporter optional */ }
try { require("solidity-coverage"); } catch (e) { /* coverage optional */ }

const { PRIVATE_KEY, SEPOLIA_RPC_URL, POLYGON_RPC_URL, ARBITRUM_RPC_URL, OPTIMISM_RPC_URL, ETHERSCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    polygon: {
      url: POLYGON_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 137,
    },
    arbitrum: {
      url: ARBITRUM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 42161,
    },
    optimism: {
      url: OPTIMISM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 10,
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    excludeContracts: [],
    src: "./contracts",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
