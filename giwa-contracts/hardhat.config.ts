import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import "dotenv/config";

const privateKey = process.env.PRIVATE_KEY?.trim();

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
      production: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  networks: {
    giwaSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.GIWA_SEPOLIA_RPC_URL || "https://sepolia-rpc.giwa.io",
      accounts: privateKey ? [privateKey] : [],
    },
  },
  chainDescriptors: {
    91342: {
      name: "Giwa Sepolia",
      blockExplorers: {
        blockscout: {
          name: "Giwa Sepolia Explorer",
          url: "https://sepolia-explorer.giwa.io",
          apiUrl: "https://sepolia-explorer.giwa.io/api",
        },
      },
    },
  },
};

export default config;
