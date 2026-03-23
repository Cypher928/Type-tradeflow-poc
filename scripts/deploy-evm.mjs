#!/usr/bin/env node
/**
 * deploy-evm.js — Deploy TradeFlowEscrow to XRPL EVM Sidechain Devnet
 *
 * Usage:
 *   node scripts/deploy-evm.js
 *
 * The script:
 *   1. Generates a fresh deployer wallet (or uses EVM_PRIVATE_KEY from .env)
 *   2. Requests faucet funding on XRPL EVM Devnet
 *   3. Compiles TradeFlowEscrow.sol via solc (must be installed: npm i -g solc)
 *   4. Deploys the contract and prints the address + explorer link
 *
 * Requirements:
 *   npm install --save-dev ethers
 *   npm install -g solc          (for on-the-fly compilation)
 *   OR set EVM_BYTECODE env var to a pre-compiled hex string
 *
 * Network:
 *   RPC      : https://rpc.evm.devnet.ripple.com
 *   Chain ID : 1440002
 *   Explorer : https://evm-sidechain.xrpl.org
 *   Faucet   : https://evm-sidechain.xrpl.org/faucet  (web UI)
 */

"use strict"

import { ethers } from "ethers"
import { execSync } from "child_process"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import dotenv from "dotenv"

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, "../.env") })

// ── Network constants ──────────────────────────────────────────────────────────

const RPC_URL   = "https://rpc.evm.devnet.ripple.com"
const CHAIN_ID  = 1440002
const EXPLORER  = "https://evm-sidechain.xrpl.org"
const FAUCET_API = "https://evm-sidechain.xrpl.org/api/faucet"  // POST {address}

const SOL_PATH  = resolve(__dirname, "../contracts/TradeFlowEscrow.sol")
const OUT_PATH  = resolve(__dirname, "../contracts/TradeFlowEscrow.json")

// ── Compile contract (requires `solc` in PATH) ─────────────────────────────────

function compile () {
  if (!existsSync(SOL_PATH)) throw new Error(`Contract not found: ${SOL_PATH}`)

  console.log("Compiling TradeFlowEscrow.sol …")
  const cmd = `solc --combined-json abi,bin --optimize "${SOL_PATH}"`
  const raw  = execSync(cmd, { encoding: "utf8" })
  const json = JSON.parse(raw)

  const key      = Object.keys(json.contracts).find(k => k.includes("TradeFlowEscrow"))
  const artifact = json.contracts[key]

  writeFileSync(OUT_PATH, JSON.stringify({ abi: JSON.parse(artifact.abi), bytecode: "0x" + artifact.bin }, null, 2))
  console.log(`  → compiled artifact saved to contracts/TradeFlowEscrow.json`)
  return artifact
}

// ── Fund wallet via faucet ─────────────────────────────────────────────────────

async function fundViaFaucet (address) {
  console.log(`Requesting faucet funding for ${address} …`)
  try {
    const resp = await fetch(FAUCET_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address })
    })
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}))
      console.log("  → Faucet response:", JSON.stringify(data))
    } else {
      console.warn(`  → Faucet returned ${resp.status} — fund manually at ${EXPLORER}/faucet`)
    }
  } catch (e) {
    console.warn(`  → Faucet request failed (${e.message}) — fund manually at ${EXPLORER}/faucet`)
  }
  // Give faucet time to process
  await new Promise(r => setTimeout(r, 8000))
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main () {
  console.log("\n╔═══════════════════════════════════════╗")
  console.log("║  TradeFlow EVM Sidechain Deploy       ║")
  console.log("╚═══════════════════════════════════════╝\n")

  // Provider
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    chainId: CHAIN_ID,
    name:    "xrpl-evm-devnet"
  })

  // Wallet — use env key or generate fresh
  let wallet
  if (process.env.EVM_PRIVATE_KEY) {
    wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider)
    console.log(`Using existing wallet: ${wallet.address}`)
  } else {
    wallet = ethers.Wallet.createRandom().connect(provider)
    console.log(`Generated deployer wallet: ${wallet.address}`)
    console.log(`  Private key (testnet only): ${wallet.privateKey}`)
    await fundViaFaucet(wallet.address)
  }

  // Check balance
  const balance = await provider.getBalance(wallet.address)
  console.log(`\nWallet balance: ${ethers.formatEther(balance)} XRP (EVM)`)
  if (balance === 0n) {
    console.error("\n✗ Wallet has no funds. Fund it at:", `${EXPLORER}/faucet`)
    console.error("  Then set EVM_PRIVATE_KEY=" + wallet.privateKey + " in .env and re-run.")
    process.exit(1)
  }

  // Compile (or load pre-compiled artifact)
  let abi, bytecode
  if (existsSync(OUT_PATH)) {
    console.log("\nLoading pre-compiled artifact from contracts/TradeFlowEscrow.json …")
    const artifact = JSON.parse(readFileSync(OUT_PATH, "utf8"))
    abi = artifact.abi
    bytecode = artifact.bytecode
  } else {
    const artifact = compile()
    abi      = JSON.parse(artifact.abi)
    bytecode = "0x" + artifact.bin
  }

  // Deploy
  console.log("\nDeploying TradeFlowEscrow …")
  const factory  = new ethers.ContractFactory(abi, bytecode, wallet)
  const contract = await factory.deploy()
  const receipt  = await contract.deploymentTransaction().wait()

  const address = await contract.getAddress()
  const txHash  = receipt.hash
  const block   = receipt.blockNumber

  console.log("\n╔═══════════════════════════════════════════════════════╗")
  console.log("║  DEPLOYMENT SUCCESSFUL                                ║")
  console.log("╚═══════════════════════════════════════════════════════╝")
  console.log(`  Contract : ${address}`)
  console.log(`  Tx hash  : ${txHash}`)
  console.log(`  Block    : ${block}`)
  console.log(`  Explorer : ${EXPLORER}/address/${address}`)
  console.log(`  Tx URL   : ${EXPLORER}/tx/${txHash}`)
  console.log("")

  // Persist result
  const result = {
    network:    "XRPL EVM Sidechain Devnet",
    chainId:    CHAIN_ID,
    rpc:        RPC_URL,
    deployer:   wallet.address,
    contract:   address,
    txHash,
    block,
    explorerUrl: `${EXPLORER}/address/${address}`,
    txUrl:       `${EXPLORER}/tx/${txHash}`,
    deployedAt: new Date().toISOString()
  }

  writeFileSync(
    resolve(__dirname, "../contracts/evm-deployment.json"),
    JSON.stringify(result, null, 2)
  )
  console.log("  Saved to contracts/evm-deployment.json")
  console.log("\nAdd these to README.md:")
  console.log(`  Contract address : ${address}`)
  console.log(`  Deploy tx        : ${EXPLORER}/tx/${txHash}`)
}

main().catch(e => {
  console.error("\n✗ Deploy failed:", e.message)
  process.exit(1)
})
