#!/usr/bin/env node
/**
 * compile-evm.js — Compile TradeFlowEscrow.sol and save artifact
 * Run: node scripts/compile-evm.js
 */
"use strict"

const solc = require("solc")
const fs   = require("fs")
const path = require("path")

const SOL_PATH = path.resolve(__dirname, "../contracts/TradeFlowEscrow.sol")
const OUT_PATH = path.resolve(__dirname, "../contracts/TradeFlowEscrow.json")

const source = fs.readFileSync(SOL_PATH, "utf8")

const input = {
  language: "Solidity",
  sources: { "TradeFlowEscrow.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
}

console.log("Compiling TradeFlowEscrow.sol with solc", solc.version(), "…")
const output = JSON.parse(solc.compile(JSON.stringify(input)))

if (output.errors) {
  const errors = output.errors.filter(e => e.severity === "error")
  if (errors.length) {
    errors.forEach(e => console.error(e.formattedMessage))
    process.exit(1)
  }
  output.errors.forEach(e => console.warn(e.formattedMessage))
}

const contract = output.contracts["TradeFlowEscrow.sol"]["TradeFlowEscrow"]
const artifact = {
  contractName: "TradeFlowEscrow",
  abi:          contract.abi,
  bytecode:     "0x" + contract.evm.bytecode.object,
  compiler:     solc.version(),
  compiledAt:   new Date().toISOString()
}

fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2))
console.log("Artifact saved to contracts/TradeFlowEscrow.json")
console.log("Bytecode length:", artifact.bytecode.length / 2 - 1, "bytes")
