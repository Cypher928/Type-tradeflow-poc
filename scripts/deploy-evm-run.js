#!/usr/bin/env node
/**
 * deploy-evm-run.js — One-shot deploy of TradeFlowEscrow to XRPL EVM Sidechain Devnet
 *
 * Requires: node scripts/compile-evm.js to have been run first
 *           (artifact at contracts/TradeFlowEscrow.json)
 *
 * Usage: node scripts/deploy-evm-run.js [privateKey]
 *   If no private key is provided, generates a fresh one and attempts faucet funding.
 */
"use strict"

const { ethers } = require("ethers")
const fs         = require("fs")
const path       = require("path")

const RPC_URL  = "https://rpc.evm.devnet.ripple.com"
const CHAIN_ID = 1440002
const EXPLORER = "https://evm-sidechain.xrpl.org"
const OUT_PATH = path.resolve(__dirname, "../contracts/TradeFlowEscrow.json")
const DEP_PATH = path.resolve(__dirname, "../contracts/evm-deployment.json")

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

async function requestFaucet (address) {
  const urls = [
    "https://evm-sidechain.xrpl.org/api/faucet",
    "https://faucet.evm.devnet.ripple.com",
    "https://evm-sidechain.xrpl.org/faucet"
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address })
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        console.log(`  → Faucet OK (${url}):`, JSON.stringify(data))
        return true
      }
    } catch (_) {}
  }
  return false
}

async function main () {
  if (!fs.existsSync(OUT_PATH)) {
    console.error("Artifact not found. Run: node scripts/compile-evm.js first")
    process.exit(1)
  }

  const artifact = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"))
  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "xrpl-evm-devnet" })

  // Wallet
  const rawKey = process.argv[2] || process.env.EVM_PRIVATE_KEY
  let wallet
  if (rawKey) {
    wallet = new ethers.Wallet(rawKey, provider)
    console.log("Using wallet:", wallet.address)
  } else {
    wallet = ethers.Wallet.createRandom().connect(provider)
    console.log("Generated wallet:", wallet.address)
    console.log("Requesting faucet …")
    const ok = await requestFaucet(wallet.address)
    if (!ok) {
      console.warn("Faucet unavailable — fund manually at", EXPLORER + "/faucet")
    }
    console.log("Waiting 10 s for faucet to confirm …")
    await sleep(10000)
  }

  const balance = await provider.getBalance(wallet.address)
  console.log("Balance:", ethers.formatEther(balance), "XRP")

  if (balance === 0n) {
    console.error("Wallet unfunded. Get testnet XRP at:", EXPLORER + "/faucet")
    console.error("Then re-run: node scripts/deploy-evm-run.js", wallet.privateKey)
    process.exit(1)
  }

  console.log("Deploying TradeFlowEscrow …")
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet)
  const contract = await factory.deploy()
  const receipt  = await contract.deploymentTransaction().wait()

  const address = await contract.getAddress()
  const txHash  = receipt.hash

  console.log("\n=== DEPLOYED ===")
  console.log("Contract :", address)
  console.log("Tx hash  :", txHash)
  console.log("Explorer :", EXPLORER + "/address/" + address)
  console.log("Tx URL   :", EXPLORER + "/tx/" + txHash)

  const result = {
    network: "XRPL EVM Sidechain Devnet",
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    deployer: wallet.address,
    contract: address,
    txHash,
    block: receipt.blockNumber,
    explorerUrl: EXPLORER + "/address/" + address,
    txUrl: EXPLORER + "/tx/" + txHash,
    deployedAt: new Date().toISOString()
  }
  fs.writeFileSync(DEP_PATH, JSON.stringify(result, null, 2))
  console.log("Saved to contracts/evm-deployment.json")
}

main().catch(e => { console.error("Deploy failed:", e.message); process.exit(1) })
