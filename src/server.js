'use strict'

require('dotenv').config()
const express    = require('express')
const xrpl       = require('xrpl')
const crypto     = require('crypto')
const path       = require('path')
const cors       = require('cors')
const rateLimit  = require('express-rate-limit')
const db         = require('./db')

const app  = express()
const port = process.env.PORT || 3000

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || `http://localhost:${port}`).split(',')
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error('Not allowed by CORS'))
  }
}))

// ─── Rate limiting ────────────────────────────────────────────────────────────
app.use('/trade',      rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }))
app.use('/settle',     rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false }))
app.use('/trust-line', rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false }))

app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

// ─── XRPL Client (persistent connection, not per-request) ────────────────────
const client = new xrpl.Client(process.env.XRPL_NODE || 'wss://s.altnet.rippletest.net:51233')

async function getClient() {
  if (!client.isConnected()) await client.connect()
  return client
}

// ─── /settle endpoint — supports XRP and RLUSD ───────────────────────────────
app.post('/settle', async (req, res) => {
  const { amount, currency } = req.body
  const walletSeed           = process.env.XRPL_WALLET_SEED
  const destinationAddress   = process.env.XRPL_DESTINATION_ADDRESS

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    return res.status(400).json({ error: 'amount must be a positive number.' })

  try {
    const result = await sendPayment(walletSeed, destinationAddress, amount, currency || 'XRP')
    res.json({ success: true, hash: result.hash, explorerUrl: result.explorerUrl })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ─── Trade endpoints ──────────────────────────────────────────────────────────

app.post('/trade', (req, res) => {
  const { counterpartyName, counterpartyAddress, totalValue, dueDate } = req.body

  if (!counterpartyName || !counterpartyAddress || !totalValue || !dueDate)
    return res.status(400).json({ error: 'counterpartyName, counterpartyAddress, totalValue, dueDate required' })

  if (!xrpl.isValidAddress(counterpartyAddress))
    return res.status(400).json({ error: 'counterpartyAddress is not a valid XRPL address' })

  const numericValue = parseFloat(totalValue)
  if (isNaN(numericValue) || numericValue <= 0)
    return res.status(400).json({ error: 'totalValue must be a positive number' })

  const id    = 'TF-' + crypto.randomBytes(4).toString('hex').toUpperCase()
  const trade = db.createTrade({
    id,
    counterpartyName:    counterpartyName.trim(),
    counterpartyAddress: counterpartyAddress.trim(),
    totalValue:          numericValue,
    dueDate,
    createdAt: new Date().toISOString(),
  })

  console.log(`Trade created: ${id}`)
  res.status(201).json({ success: true, trade })
})

app.get('/trades', (_req, res) => {
  res.json({ success: true, trades: db.getAll() })
})

app.post('/trade/:id/reconcile', async (req, res) => {
  const trade = db.getById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })

  const { walletSeed, yourShare, invoiceHash } = req.body
  if (!walletSeed || yourShare === undefined)
    return res.status(400).json({ error: 'walletSeed and yourShare are required' })

  try {
    const result = await recordReconciliation(walletSeed, {
      tradeId:      trade.id,
      totalCost:    trade.totalValue,
      yourShare:    parseFloat(yourShare),
      counterparty: trade.counterpartyAddress,
      invoiceHash:  invoiceHash || crypto.createHash('sha256').update(trade.id).digest('hex'),
    })

    const updated = db.updateTrade(trade.id, {
      status:        'reconciled',
      reconciliation: { yourShare: parseFloat(yourShare), onChain: result, recordedAt: new Date().toISOString() },
      settlement:    trade.settlement,
    })

    res.json({ success: true, trade: updated, onChain: result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/trade/:id/settle', async (req, res) => {
  const trade = db.getById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })

  const { senderSeed, currency } = req.body
  if (!senderSeed) return res.status(400).json({ error: 'senderSeed is required' })

  const amount = trade.reconciliation
    ? String(trade.reconciliation.yourShare)
    : String(trade.totalValue)

  try {
    const result = await sendPayment(senderSeed, trade.counterpartyAddress, amount, currency || 'RLUSD', trade.id)

    const updated = db.updateTrade(trade.id, {
      status:        'settled',
      reconciliation: trade.reconciliation,
      settlement:    { amount, currency: currency || 'RLUSD', onChain: result, settledAt: new Date().toISOString() },
    })

    res.json({ success: true, trade: updated, onChain: result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Trust line endpoints ─────────────────────────────────────────────────────

app.get('/trust-lines/:address', async (req, res) => {
  const { address } = req.params
  if (!xrpl.isValidAddress(address))
    return res.status(400).json({ error: 'Invalid XRPL address' })

  try {
    const c        = await getClient()
    const response = await c.request({ command: 'account_lines', account: address, ledger_index: 'validated' })
    const lines    = response.result.lines.map(line => ({
      currency:  line.currency,
      issuer:    line.account,
      balance:   line.balance,
      limit:     line.limit,
      limitPeer: line.limit_peer,
    }))
    res.json({ success: true, address, trustLines: lines })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/trust-line', async (req, res) => {
  const { walletSeed, limit } = req.body
  if (!walletSeed) return res.status(400).json({ error: 'walletSeed is required' })

  try {
    const c            = await getClient()
    const wallet       = xrpl.Wallet.fromSeed(walletSeed)
    const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'
    const tx = {
      TransactionType: 'TrustSet',
      Account: wallet.address,
      LimitAmount: {
        currency: '524C555344000000000000000000000000000000',
        issuer:   RLUSD_ISSUER,
        value:    String(limit || '1000000'),
      },
    }
    const prepared = await c.autofill(tx)
    const signed   = wallet.sign(prepared)
    const result   = await c.submitAndWait(signed.tx_blob)
    res.json({
      success:     true,
      hash:        result.result.hash,
      status:      result.result.meta.TransactionResult,
      explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}`,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', network: 'XRPL Testnet', timestamp: new Date().toISOString() })
})

// ─── Core payment function ────────────────────────────────────────────────────
async function sendPayment(seed, destination, amount, currency = 'XRP', tradeId = null) {
  const c            = await getClient()
  const wallet       = xrpl.Wallet.fromSeed(seed)
  const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'

  const paymentAmount = currency === 'XRP'
    ? xrpl.xrpToDrops(amount)
    : { currency: '524C555344000000000000000000000000000000', issuer: RLUSD_ISSUER, value: String(amount) }

  const tx = {
    TransactionType: 'Payment',
    Account:         wallet.address,
    Destination:     destination,
    Amount:          paymentAmount,
    ...(tradeId && { Memos: [{ Memo: {
      MemoType: Buffer.from('TradeFlow/TradeID', 'utf8').toString('hex').toUpperCase(),
      MemoData: Buffer.from(tradeId,             'utf8').toString('hex').toUpperCase(),
    }}] }),
  }

  const prepared = await c.autofill(tx)
  const signed   = wallet.sign(prepared)
  const response = await c.submitAndWait(signed.tx_blob)
  console.log('Transaction:', response.result.hash)

  return {
    hash:        response.result.hash,
    status:      response.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${response.result.hash}`,
  }
}

// ─── Reconciliation on-chain record ──────────────────────────────────────────
async function recordReconciliation(seed, data) {
  const c      = await getClient()
  const wallet = xrpl.Wallet.fromSeed(seed)

  const tx = {
    TransactionType: 'Payment',
    Account:         wallet.address,
    Destination:     data.counterparty,
    Amount:          '1',
    Memos: [{ Memo: {
      MemoType: Buffer.from('TradeFlow/Reconciliation', 'utf8').toString('hex').toUpperCase(),
      MemoData: Buffer.from(JSON.stringify(data),       'utf8').toString('hex').toUpperCase(),
    }}],
  }

  const prepared = await c.autofill(tx)
  const signed   = wallet.sign(prepared)
  const response = await c.submitAndWait(signed.tx_blob)
  return {
    hash:        response.result.hash,
    status:      response.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${response.result.hash}`,
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log('\nShutting down…')
  if (client.isConnected()) await client.disconnect()
  db.close()
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`TradeFlow server running on port ${port}`)
})
