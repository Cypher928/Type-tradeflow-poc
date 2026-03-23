const xrpl = require("xrpl")

// ─── Persistent XRPL client ───────────────────────────────────────────────────
const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233")

async function connectXRPL() {
  if (!client.isConnected()) {
    await client.connect()
    console.log("Connected to XRPL Testnet")
  }
  return client
}

async function disconnect() {
  if (client.isConnected()) {
    await client.disconnect()
    console.log("Disconnected from XRPL")
  }
}

// ─── XRP payment with memo ────────────────────────────────────────────────────
async function sendTestPayment({ fromSeed, toAddress, amount, memo }) {
  const c = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(fromSeed)

  const tx = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Amount: xrpl.xrpToDrops(amount),
    Destination: toAddress,
    Memos: memo
      ? [{ Memo: { MemoType: Buffer.from("trade").toString("hex"), MemoData: Buffer.from(memo).toString("hex") } }]
      : []
  }

  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)
  return result
}

// ─── RLUSD payment ────────────────────────────────────────────────────────────
const RLUSD_ISSUER = process.env.RLUSD_ISSUER || "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000"

async function sendRLUSDPayment({ fromSeed, toAddress, amount, tradeId, invoiceHash }) {
  const c = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(fromSeed)

  const memos = []
  if (tradeId) {
    memos.push({ Memo: { MemoType: Buffer.from("TradeFlow/TradeID").toString("hex").toUpperCase(), MemoData: Buffer.from(tradeId).toString("hex").toUpperCase() } })
  }
  if (invoiceHash) {
    memos.push({ Memo: { MemoType: Buffer.from("TradeFlow/InvoiceHash").toString("hex").toUpperCase(), MemoData: Buffer.from(invoiceHash).toString("hex").toUpperCase() } })
  }

  const tx = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: toAddress,
    Amount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: String(amount) },
    Memos: memos
  }

  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)

  return {
    hash: result.result.hash,
    status: result.result.meta.TransactionResult,
    success: result.result.meta.TransactionResult === "tesSUCCESS",
    explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`
  }
}

// ─── Trust line (required before receiving RLUSD) ────────────────────────────
async function setRLUSDTrustLine({ walletSeed, limit = "1000000" }) {
  const c = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(walletSeed)

  const tx = {
    TransactionType: "TrustSet",
    Account: wallet.classicAddress,
    LimitAmount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: limit }
  }

  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)

  return {
    hash: result.result.hash,
    status: result.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`
  }
}

// ─── On-chain reconciliation record ──────────────────────────────────────────
async function recordReconciliationOnChain({ walletSeed, counterpartyAddress, tradeId, totalCost, yourShare, invoiceHash }) {
  const c = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(walletSeed)

  const payload = JSON.stringify({ tradeId, totalCost, yourShare, invoiceHash })

  const tx = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: counterpartyAddress,
    Amount: "1",
    Memos: [{
      Memo: {
        MemoType: Buffer.from("TradeFlow/Reconciliation").toString("hex").toUpperCase(),
        MemoData: Buffer.from(payload).toString("hex").toUpperCase()
      }
    }]
  }

  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)

  return {
    hash: result.result.hash,
    status: result.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`,
    payload
  }
}

// ─── NFT — tokenize reconciled invoice as RWA (NFTokenMint) ──────────────────
// MPTokenIssuanceCreate requires the MPToken amendment; altnet uses NFTokenMint
// for the same purpose. Production path will migrate to MPT once live on mainnet.
async function tokenizeInvoiceAsMPT({ issuerSeed, tradeId, invoiceAmount, dueDate, invoiceHash }) {
  const c = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(issuerSeed)

  const metadata = JSON.stringify({
    type: "TradeFinanceInvoice",
    tradeId,
    invoiceAmount,
    dueDate,
    invoiceHash,
    platform: "TradeFlow Ledger"
  })

  const tx = {
    TransactionType: "NFTokenMint",
    Account: wallet.classicAddress,
    NFTokenTaxon: 0,
    Flags: 8, // tfTransferable
    URI: Buffer.from(metadata).toString("hex").toUpperCase(),
    Memos: [{
      Memo: {
        MemoType: Buffer.from("TradeFlow/InvoiceTokenization").toString("hex").toUpperCase(),
        MemoData: Buffer.from(tradeId).toString("hex").toUpperCase()
      }
    }]
  }

  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)

  return {
    hash: result.result.hash,
    status: result.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`,
    metadata
  }
}

// ─── Escrow ───────────────────────────────────────────────────────────────────
async function createEscrow({ senderSeed, destination, xrpAmount, releaseAfterSeconds, tradeId }) {
  const c = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(senderSeed)

  // Ripple epoch starts Jan 1 2000; XRPL FinishAfter requires seconds since Ripple epoch
  const RIPPLE_EPOCH_OFFSET = 946684800
  const releaseTime = Math.floor(Date.now() / 1000) + releaseAfterSeconds - RIPPLE_EPOCH_OFFSET

  const tx = {
    TransactionType: "EscrowCreate",
    Account: wallet.classicAddress,
    Destination: destination,
    Amount: xrpl.xrpToDrops(xrpAmount),
    FinishAfter: releaseTime,
    Memos: [{
      Memo: {
        MemoType: Buffer.from("TradeFlow/TradeID").toString("hex").toUpperCase(),
        MemoData: Buffer.from(tradeId).toString("hex").toUpperCase()
      }
    }]
  }

  const prepared = await c.autofill(tx)
  const escrowSequence = prepared.Sequence  // capture before signing; tx_json structure varies by lib version
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)

  return {
    hash: result.result.hash,
    status: result.result.meta.TransactionResult,
    escrowSequence,
    escrowOwner: wallet.classicAddress,
    explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`
  }
}

async function finishEscrow({ finisherSeed, escrowOwner, escrowSequence }) {
  const c = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(finisherSeed)

  const tx = {
    TransactionType: "EscrowFinish",
    Account: wallet.classicAddress,
    Owner: escrowOwner,
    OfferSequence: escrowSequence
  }

  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await c.submitAndWait(signed.tx_blob)

  return {
    hash: result.result.hash,
    status: result.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`
  }
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────
async function fundTestnetWallet() {
  const c = await connectXRPL()
  const { wallet } = await c.fundWallet()
  console.log(`New wallet funded: ${wallet.address}`)
  return { address: wallet.address, seed: wallet.seed }
}

async function getBalances(address) {
  const c = await connectXRPL()
  const info = await c.request({ command: "account_info", account: address, ledger_index: "validated" })
  return {
    address,
    xrpBalance: xrpl.dropsToXrp(info.result.account_data.Balance)
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  connectXRPL,
  disconnect,
  sendTestPayment,
  sendRLUSDPayment,
  setRLUSDTrustLine,
  recordReconciliationOnChain,
  tokenizeInvoiceAsMPT,
  createEscrow,
  finishEscrow,
  fundTestnetWallet,
  getBalances,
  RLUSD_CURRENCY,
  RLUSD_ISSUER
}
