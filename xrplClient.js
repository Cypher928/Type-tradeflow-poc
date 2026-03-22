const xrpl = require(“xrpl”)

// ─── Your original client setup, kept as-is ──────────────────────────────────
const client = new xrpl.Client(“wss://s.altnet.rippletest.net:51233”)

async function connectXRPL() {
if (!client.isConnected()) {
await client.connect()
console.log(“✅ Connected to XRPL Testnet”)
}
return client
}

async function disconnect() {
if (client.isConnected()) {
await client.disconnect()
console.log(“🔌 Disconnected from XRPL”)
}
}

// ─── Your original sendTestPayment — fixed shadow bug, added tradeId memo ────
// Fix: inner `const client` was shadowing outer client variable
async function sendTestPayment({ fromSeed, toAddress, amount, memo }) {
const c = await connectXRPL() // fix: renamed to avoid shadowing outer `client`
const wallet = xrpl.Wallet.fromSeed(fromSeed)

const tx = {
TransactionType: “Payment”,
Account: wallet.classicAddress,
Amount: xrpl.xrpToDrops(amount),
Destination: toAddress,
Memos: memo
? [
{
Memo: {
MemoType: Buffer.from(“trade”).toString(“hex”),
MemoData: Buffer.from(memo).toString(“hex”)
}
}
]
: []
}

const prepared = await c.autofill(tx)
const signed = wallet.sign(prepared)
const result = await c.submitAndWait(signed.tx_blob)

return result
}

// ─── RLUSD Payment (your sendTestPayment extended for stablecoins) ────────────
const RLUSD_ISSUER = process.env.RLUSD_ISSUER || “rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh”
const RLUSD_CURRENCY = “524C555344000000000000000000000000000000” // “RLUSD” hex-padded

async function sendRLUSDPayment({ fromSeed, toAddress, amount, tradeId, invoiceHash }) {
const c = await connectXRPL()
const wallet = xrpl.Wallet.fromSeed(fromSeed)

const memos = []

if (tradeId) {
memos.push({
Memo: {
MemoType: Buffer.from(“TradeFlow/TradeID”).toString(“hex”).toUpperCase(),
MemoData: Buffer.from(tradeId).toString(“hex”).toUpperCase()
}
})
}

if (invoiceHash) {
memos.push({
Memo: {
MemoType: Buffer.from(“TradeFlow/InvoiceHash”).toString(“hex”).toUpperCase(),
MemoData: Buffer.from(invoiceHash).toString(“hex”).toUpperCase()
}
})
}

const tx = {
TransactionType: “Payment”,
Account: wallet.classicAddress,
Destination: toAddress,
Amount: {
currency: RLUSD_CURRENCY,
issuer: RLUSD_ISSUER,
value: String(amount)
},
Memos: memos
}

const prepared = await c.autofill(tx)
const signed = wallet.sign(prepared)
const result = await c.submitAndWait(signed.tx_blob)

return {
hash: result.result.hash,
status: result.result.meta.TransactionResult,
success: result.result.meta.TransactionResult === “tesSUCCESS”,
explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`
}
}

// ─── Trust Line (required before receiving RLUSD) ─────────────────────────────
async function setRLUSDTrustLine({ walletSeed, limit = “1000000” }) {
const c = await connectXRPL()
const wallet = xrpl.Wallet.fromSeed(walletSeed)

const tx = {
TransactionType: “TrustSet”,
Account: wallet.classicAddress,
LimitAmount: {
currency: RLUSD_CURRENCY,
issuer: RLUSD_ISSUER,
value: limit
}
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

// ─── On-chain reconciliation record (immutable audit trail) ──────────────────
// Same pattern as your sendTestPayment but writes reconciliation data as memo
async function recordReconciliationOnChain({ walletSeed, counterpartyAddress, tradeId, totalCost, yourShare, invoiceHash }) {
const c = await connectXRPL()
const wallet = xrpl.Wallet.fromSeed(walletSeed)

const payload = JSON.stringify({ tradeId, totalCost, yourShare, invoiceHash })

const tx = {
TransactionType: “Payment”,
Account: wallet.classicAddress,
Destination: counterpartyAddress,
Amount: “1”, // 1 drop — just enough to carry the memo
Memos: [
{
Memo: {
MemoType: Buffer.from(“TradeFlow/Reconciliation”).toString(“hex”).toUpperCase(),
MemoData: Buffer.from(payload).toString(“hex”).toUpperCase()
}
}
]
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

// ─── MPT — tokenize reconciled invoice as RWA ────────────────────────────────
async function tokenizeInvoiceAsMPT({ issuerSeed, tradeId, invoiceAmount, dueDate, invoiceHash }) {
const c = await connectXRPL()
const wallet = xrpl.Wallet.fromSeed(issuerSeed)

const metadata = JSON.stringify({
type: “TradeFinanceInvoice”,
tradeId,
invoiceAmount,
dueDate,
invoiceHash,
platform: “TradeFlow Ledger”
})

const tx = {
TransactionType: “MPTokenIssuanceCreate”,
Account: wallet.classicAddress,
AssetScale: 2,
MaximumAmount: String(Math.round(invoiceAmount * 100)),
MPTokenMetadata: Buffer.from(metadata).toString(“hex”).toUpperCase(),
Flags: 0x00000040 // tfMPTCanTransfer
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

// ─── Escrow — conditional settlement with time lock ──────────────────────────
async function createEscrow({ senderSeed, destination, xrpAmount, releaseAfterSeconds, tradeId }) {
const c = await connectXRPL()
const wallet = xrpl.Wallet.fromSeed(senderSeed)

const releaseTime = xrpl.unixTimeToRippleTime(
Math.floor(Date.now() / 1000) + releaseAfterSeconds
)

const tx = {
TransactionType: “EscrowCreate”,
Account: wallet.classicAddress,
Destination: destination,
Amount: xrpl.xrpToDrops(xrpAmount),
FinishAfter: releaseTime,
Memos: [
{
Memo: {
MemoType: Buffer.from(“TradeFlow/TradeID”).toString(“hex”).toUpperCase(),
MemoData: Buffer.from(tradeId).toString(“hex”).toUpperCase()
}
}
]
}

const prepared = await c.autofill(tx)
const signed = wallet.sign(prepared)
const result = await c.submitAndWait(signed.tx_blob)

return {
hash: result.result.hash,
status: result.result.meta.TransactionResult,
escrowSequence: result.result.tx_json.Sequence,
escrowOwner: wallet.classicAddress,
explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`
}
}

async function finishEscrow({ finisherSeed, escrowOwner, escrowSequence }) {
const c = await connectXRPL()
const wallet = xrpl.Wallet.fromSeed(finisherSeed)

const tx = {
TransactionType: “EscrowFinish”,
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
console.log(`🪙  New wallet funded: ${wallet.address}`)
return { address: wallet.address, seed: wallet.seed }
}

async function getBalances(address) {
const c = await connectXRPL()
const info = await c.request({
command: “account_info”,
account: address,
ledger_index: “validated”
})
return {
address,
xrpBalance: xrpl.dropsToXrp(info.result.account_data.Balance)
}
}

// ─── Exports (your original + new functions) ─────────────────────────────────
module.exports = {
connectXRPL,
disconnect,
sendTestPayment,            // your original — still here
sendRLUSDPayment,           // new
setRLUSDTrustLine,          // new
recordReconciliationOnChain, // new
tokenizeInvoiceAsMPT,       // new
createEscrow,               // new
finishEscrow,               // new
fundTestnetWallet,          // new
getBalances,                // new
RLUSD_CURRENCY,
RLUSD_ISSUER
}
