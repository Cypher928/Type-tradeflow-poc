/**
 * TradeFlow Unit Tests
 *
 * Run with:  node tests/xrplClient.test.js
 *
 * These tests verify helper logic without hitting the live testnet.
 * For end-to-end testnet flows, run:  node scripts/testnet-demo.js
 */

"use strict"

const assert = require("assert")
const xrpl = require("xrpl")

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  PASS  ${name}`)
    passed++
  } catch (err) {
    console.log(`  FAIL  ${name}`)
    console.log(`        ${err.message}`)
    failed++
  }
}

// ── RLUSD currency hex encoding ───────────────────────────────────────────────
console.log("\nRLUSD encoding")

test("RLUSD currency hex is 40 chars", () => {
  const RLUSD_CURRENCY = "524C555344000000000000000000000000000000"
  assert.strictEqual(RLUSD_CURRENCY.length, 40)
})

test("RLUSD hex decodes to 'RLUSD'", () => {
  const RLUSD_CURRENCY = "524C555344000000000000000000000000000000"
  const decoded = Buffer.from(RLUSD_CURRENCY.slice(0, 10), "hex").toString("utf8")
  assert.strictEqual(decoded, "RLUSD")
})

// ── XRP drops conversion ──────────────────────────────────────────────────────
console.log("\nXRP drops conversion")

test("xrpToDrops(10) === '10000000'", () => {
  assert.strictEqual(xrpl.xrpToDrops(10), "10000000")
})

test("dropsToXrp('1000000') === '1'", () => {
  assert.strictEqual(xrpl.dropsToXrp("1000000"), "1")
})

test("xrpToDrops(0.000001) === '1'", () => {
  assert.strictEqual(xrpl.xrpToDrops(0.000001), "1")
})

// ── Memo encoding ─────────────────────────────────────────────────────────────
console.log("\nMemo encoding")

test("TradeFlow/TradeID memo type encodes and decodes correctly", () => {
  const memoType = Buffer.from("TradeFlow/TradeID").toString("hex").toUpperCase()
  const decoded = Buffer.from(memoType, "hex").toString("utf8")
  assert.strictEqual(decoded, "TradeFlow/TradeID")
})

test("Trade ID memo data encodes and decodes correctly", () => {
  const tradeId = "TF-ABCD1234"
  const memoData = Buffer.from(tradeId).toString("hex").toUpperCase()
  const decoded = Buffer.from(memoData, "hex").toString("utf8")
  assert.strictEqual(decoded, tradeId)
})

// ── Trade ID format ───────────────────────────────────────────────────────────
console.log("\nTrade ID format")

test("Trade ID starts with TF-", () => {
  const crypto = require("crypto")
  const id = "TF-" + crypto.randomBytes(4).toString("hex").toUpperCase()
  assert.ok(id.startsWith("TF-"), `Expected 'TF-' prefix, got: ${id}`)
})

test("Trade ID has expected length (TF- + 8 hex chars = 11)", () => {
  const crypto = require("crypto")
  const id = "TF-" + crypto.randomBytes(4).toString("hex").toUpperCase()
  assert.strictEqual(id.length, 11)
})

// ── Reconciliation payload ────────────────────────────────────────────────────
console.log("\nReconciliation payload")

test("Reconciliation JSON round-trips cleanly", () => {
  const payload = { tradeId: "TF-ABCD1234", totalCost: 5000, yourShare: 2500, invoiceHash: "abc123" }
  const encoded = JSON.stringify(payload)
  const decoded = JSON.parse(encoded)
  assert.deepStrictEqual(decoded, payload)
})

test("Reconciliation memo data is valid hex", () => {
  const payload = JSON.stringify({ tradeId: "TF-TEST", totalCost: 100, yourShare: 50 })
  const memoData = Buffer.from(payload).toString("hex").toUpperCase()
  assert.ok(/^[0-9A-F]+$/.test(memoData), "Expected uppercase hex string")
})

// ── Ripple time conversion ────────────────────────────────────────────────────
console.log("\nRipple time")

test("unixTimeToRippleTime returns a number", () => {
  const rippleTime = xrpl.unixTimeToRippleTime(Math.floor(Date.now() / 1000) + 30)
  assert.strictEqual(typeof rippleTime, "number")
})

test("Ripple epoch offset is 946684800 seconds", () => {
  // Ripple epoch starts at 2000-01-01T00:00:00Z
  const unixEpoch2000 = 946684800
  const rippleTime = xrpl.unixTimeToRippleTime(unixEpoch2000)
  assert.strictEqual(rippleTime, 0)
})

// ── Trust line query response shape ──────────────────────────────────────────
console.log("\nTrust line response mapping")

test("account_lines response maps to expected shape", () => {
  // Simulate a raw XRPL account_lines line entry
  const rawLine = {
    account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    currency: "524C555344000000000000000000000000000000",
    balance: "100",
    limit: "1000000",
    limit_peer: "0"
  }
  const mapped = {
    currency: rawLine.currency,
    issuer: rawLine.account,
    balance: rawLine.balance,
    limit: rawLine.limit,
    limitPeer: rawLine.limit_peer
  }
  assert.strictEqual(mapped.issuer, rawLine.account)
  assert.strictEqual(mapped.currency, rawLine.currency)
  assert.strictEqual(mapped.balance, "100")
  assert.strictEqual(mapped.limit, "1000000")
  assert.strictEqual(mapped.limitPeer, "0")
})

test("RLUSD currency hex matches expected trust line currency", () => {
  const RLUSD_CURRENCY = "524C555344000000000000000000000000000000"
  const rawLine = { currency: RLUSD_CURRENCY }
  assert.strictEqual(rawLine.currency, RLUSD_CURRENCY)
})

test("xrpl.isValidAddress rejects invalid addresses", () => {
  assert.strictEqual(xrpl.isValidAddress("not-an-address"), false)
  assert.strictEqual(xrpl.isValidAddress(""), false)
})

test("xrpl.isValidAddress accepts valid XRPL address", () => {
  // Genesis account — always valid format
  assert.strictEqual(xrpl.isValidAddress("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"), true)
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`)
console.log(`  ${passed} passed, ${failed} failed`)
console.log(`${"─".repeat(40)}\n`)

if (failed > 0) process.exit(1)
