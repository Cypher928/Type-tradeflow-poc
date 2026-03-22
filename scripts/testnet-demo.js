/**
 * TradeFlow XRPL Testnet Demo
 * ============================================================
 * Runs a full end-to-end trade finance flow on XRPL Testnet and
 * prints live explorer URLs for every transaction.
 *
 * Usage:  node scripts/testnet-demo.js
 *
 * What it demonstrates
 * --------------------
 * 1. Fund two fresh testnet wallets  (exporter + importer)
 * 2. Set RLUSD trust lines on both wallets
 * 3. XRP payment with TradeFlow memo   — simulates trade deposit
 * 4. On-chain reconciliation record    — immutable audit trail
 * 5. Escrow create                     — conditional settlement lock
 * 6. Escrow finish                     — settlement release
 * 7. MPT invoice tokenisation          — RWA tokenisation of invoice
 */

"use strict"

const {
  connectXRPL,
  disconnect,
  fundTestnetWallet,
  setRLUSDTrustLine,
  sendTestPayment,
  recordReconciliationOnChain,
  createEscrow,
  finishEscrow,
  tokenizeInvoiceAsMPT,
  getBalances,
} = require("../src/xrplClient")

// ── helpers ──────────────────────────────────────────────────────────────────

function header(title) {
  const line = "─".repeat(60)
  console.log(`\n${line}`)
  console.log(`  ${title}`)
  console.log(line)
}

function ok(label, result) {
  const status = result.status || result.meta?.TransactionResult || "?"
  const emoji = status === "tesSUCCESS" ? "✅" : "⚠️ "
  console.log(`${emoji} ${label}`)
  console.log(`   Status : ${status}`)
  console.log(`   Hash   : ${result.hash}`)
  console.log(`   URL    : ${result.explorerUrl}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── main demo ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🚀  TradeFlow XRPL Testnet Demo")
  console.log("    Connecting to XRPL Altnet …")

  await connectXRPL()
  console.log("    Connected.\n")

  // ── STEP 1 — Fund wallets ────────────────────────────────────────────────
  header("STEP 1 — Fund Testnet Wallets")
  console.log("    Requesting faucet funds for Exporter …")
  const exporter = await fundTestnetWallet()
  console.log(`    Exporter  : ${exporter.address}`)

  console.log("    Requesting faucet funds for Importer …")
  const importer = await fundTestnetWallet()
  console.log(`    Importer  : ${importer.address}`)

  // Small delay to let ledger settle between faucet calls
  await sleep(3000)

  const expBal = await getBalances(exporter.address)
  const impBal = await getBalances(importer.address)
  console.log(`    Exporter balance : ${expBal.xrpBalance} XRP`)
  console.log(`    Importer balance : ${impBal.xrpBalance} XRP`)

  // ── STEP 2 — Set RLUSD trust lines ──────────────────────────────────────
  header("STEP 2 — Set RLUSD Trust Lines")
  console.log("    Setting trust line for Exporter …")
  const trustExp = await setRLUSDTrustLine({ walletSeed: exporter.seed })
  ok("Exporter TrustSet", trustExp)

  console.log("    Setting trust line for Importer …")
  const trustImp = await setRLUSDTrustLine({ walletSeed: importer.seed })
  ok("Importer TrustSet", trustImp)

  // ── STEP 3 — XRP payment with trade memo ────────────────────────────────
  header("STEP 3 — XRP Payment (trade deposit memo)")
  const tradeId = `TF-${Date.now()}`
  const paymentResult = await sendTestPayment({
    fromSeed: importer.seed,
    toAddress: exporter.address,
    amount: 10,
    memo: tradeId,
  })
  ok("XRP Payment", {
    hash: paymentResult.result.hash,
    status: paymentResult.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${paymentResult.result.hash}`,
  })

  // ── STEP 4 — On-chain reconciliation record ──────────────────────────────
  header("STEP 4 — On-Chain Reconciliation Record")
  const invoiceHash = `INV-${Date.now().toString(16).toUpperCase()}`
  const reconResult = await recordReconciliationOnChain({
    walletSeed: exporter.seed,
    counterpartyAddress: importer.address,
    tradeId,
    totalCost: 5000,
    yourShare: 2500,
    invoiceHash,
  })
  ok("Reconciliation", reconResult)
  console.log(`   Payload : ${reconResult.payload}`)

  // ── STEP 5 — Create escrow ───────────────────────────────────────────────
  header("STEP 5 — Create Escrow (conditional settlement)")
  const escrowResult = await createEscrow({
    senderSeed: importer.seed,
    destination: exporter.address,
    xrpAmount: 5,
    releaseAfterSeconds: 30,   // 30-second lock — short enough for a demo
    tradeId,
  })
  ok("EscrowCreate", escrowResult)
  console.log(`   Escrow sequence : ${escrowResult.escrowSequence}`)
  console.log(`   Escrow owner    : ${escrowResult.escrowOwner}`)

  // ── STEP 6 — Finish escrow after lock expires ────────────────────────────
  header("STEP 6 — Finish Escrow (release settlement)")
  console.log("    Waiting 35 s for FinishAfter time to pass …")
  await sleep(35_000)

  const finishResult = await finishEscrow({
    finisherSeed: importer.seed,
    escrowOwner: escrowResult.escrowOwner,
    escrowSequence: escrowResult.escrowSequence,
  })
  ok("EscrowFinish", finishResult)

  // ── STEP 7 — Tokenise invoice as MPT ────────────────────────────────────
  header("STEP 7 — Tokenise Invoice as MPT (RWA)")
  const mptResult = await tokenizeInvoiceAsMPT({
    issuerSeed: exporter.seed,
    tradeId,
    invoiceAmount: 5000,
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    invoiceHash,
  })
  ok("MPTokenIssuanceCreate", mptResult)

  // ── Summary ──────────────────────────────────────────────────────────────
  const summaryLine = "═".repeat(60)
  console.log(`\n${summaryLine}`)
  console.log("  TRADEFLOW DEMO COMPLETE — Copy these URLs for your grant application")
  console.log(summaryLine)
  console.log(`\n  Exporter wallet : https://testnet.xrpl.org/accounts/${exporter.address}`)
  console.log(`  Importer wallet : https://testnet.xrpl.org/accounts/${importer.address}`)
  console.log(`\n  Transactions`)
  console.log(`  ┌─ Exporter TrustSet   → ${trustExp.explorerUrl}`)
  console.log(`  ├─ Importer TrustSet   → ${trustImp.explorerUrl}`)
  const payHash = paymentResult.result.hash
  console.log(`  ├─ XRP Payment         → https://testnet.xrpl.org/transactions/${payHash}`)
  console.log(`  ├─ Reconciliation      → ${reconResult.explorerUrl}`)
  console.log(`  ├─ EscrowCreate        → ${escrowResult.explorerUrl}`)
  console.log(`  ├─ EscrowFinish        → ${finishResult.explorerUrl}`)
  console.log(`  └─ MPT Tokenisation    → ${mptResult.explorerUrl}`)
  console.log(`\n  Trade ID   : ${tradeId}`)
  console.log(`  Invoice ID : ${invoiceHash}`)
  console.log(`\n${summaryLine}\n`)

  await disconnect()
}

main().catch((err) => {
  console.error("\n❌  Demo failed:", err.message || err)
  process.exit(1)
})
