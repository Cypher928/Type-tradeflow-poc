'use strict'

require('dotenv').config()
const express   = require('express')
const xrpl      = require('xrpl')
const crypto    = require('crypto')
const path      = require('path')
const cors      = require('cors')
const rateLimit = require('express-rate-limit')
const db        = require('./db')
const { hashPassword, verifyPassword, signToken, requireAuth } = require('./auth')
const xumm      = require('./xumm')

const app  = express()
const port = process.env.PORT || 3000

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || `http://localhost:${port}`).split(',')
app.use(cors({
  origin: (origin, cb) => (!origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS')))
}))

// ─── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter  = rateLimit({ windowMs: 15 * 60_000, max: 20,  standardHeaders: true, legacyHeaders: false })
const tradeLimiter = rateLimit({ windowMs: 60_000,       max: 30,  standardHeaders: true, legacyHeaders: false })
const payLimiter   = rateLimit({ windowMs: 60_000,       max: 10,  standardHeaders: true, legacyHeaders: false })

app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

// ─── XRPL Client ─────────────────────────────────────────────────────────────
const client = new xrpl.Client(process.env.XRPL_NODE || 'wss://s.altnet.rippletest.net:51233')
async function getClient() {
  if (!client.isConnected()) await client.connect()
  return client
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /auth/register
app.post('/auth/register', authLimiter, async (req, res) => {
  const { email, password } = req.body
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' })
  if (password.length < 8)
    return res.status(400).json({ error: 'password must be at least 8 characters' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'invalid email address' })

  if (db.getUserByEmail(email.toLowerCase()))
    return res.status(409).json({ error: 'an account with that email already exists' })

  const passwordHash = await hashPassword(password)
  const user = db.createUser({ id: crypto.randomUUID(), email: email.toLowerCase(), passwordHash })
  const token = signToken(user.id)
  res.status(201).json({ success: true, token, user })
})

// POST /auth/login
app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' })

  const record = db.getUserByEmail(email.toLowerCase())
  if (!record) return res.status(401).json({ error: 'invalid email or password' })

  const ok = await verifyPassword(password, record.passwordHash)
  if (!ok)  return res.status(401).json({ error: 'invalid email or password' })

  const token = signToken(record.id)
  const { passwordHash: _, ...user } = record
  res.json({ success: true, token, user })
})

// GET /auth/me
app.get('/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId)
  if (!user) return res.status(404).json({ error: 'user not found' })
  res.json({ success: true, user })
})

// POST /auth/wallet — link an XRPL address to the logged-in account
app.post('/auth/wallet', requireAuth, (req, res) => {
  const { xrplAddress } = req.body
  if (!xrplAddress || !xrpl.isValidAddress(xrplAddress))
    return res.status(400).json({ error: 'valid xrplAddress is required' })

  const user = db.setWalletAddress(req.userId, xrplAddress)
  res.json({ success: true, user })
})

// ═══════════════════════════════════════════════════════════════════════════════
// XUMM SIGNING ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /xumm/sign — create a XUMM sign request for any XRPL transaction
// Body: { txjson, tradeId?, action? }
app.post('/xumm/sign', requireAuth, payLimiter, async (req, res) => {
  const { txjson, tradeId, action } = req.body
  if (!txjson || !txjson.TransactionType)
    return res.status(400).json({ error: 'txjson with TransactionType is required' })

  try {
    const result = await xumm.createPayload(txjson, {
      returnUrl: `${process.env.APP_URL || `http://localhost:${port}`}/`
    })
    db.saveXummPayload({ uuid: result.uuid, tradeId: tradeId || null, action: action || txjson.TransactionType, userId: req.userId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /xumm/payload/:uuid — poll signing status
app.get('/xumm/payload/:uuid', requireAuth, async (req, res) => {
  const record = db.getXummPayload(req.params.uuid)
  if (!record) return res.status(404).json({ error: 'payload not found' })
  if (record.user_id && record.user_id !== req.userId)
    return res.status(403).json({ error: 'forbidden' })

  try {
    const status = await xumm.getPayloadStatus(req.params.uuid)

    if (status.signed && !record.resolved) {
      db.resolveXummPayload(req.params.uuid, status.txid)

      // Automatically update the trade if this payload is linked to one
      if (record.trade_id) {
        const trade = db.getTradeById(record.trade_id)
        if (trade) {
          const explorerUrl = `https://testnet.xrpl.org/transactions/${status.txid}`
          if (record.action === 'reconcile') {
            db.updateTrade(trade.id, {
              status: 'reconciled',
              reconciliation: { onChain: { hash: status.txid, explorerUrl }, recordedAt: new Date().toISOString() },
              settlement: trade.settlement,
            })
          } else if (record.action === 'settle') {
            db.updateTrade(trade.id, {
              status: 'settled',
              reconciliation: trade.reconciliation,
              settlement: { onChain: { hash: status.txid, explorerUrl }, settledAt: new Date().toISOString() },
            })
          } else if (record.action === 'tokenise') {
            db.updateTrade(trade.id, {
              status: 'tokenised',
              reconciliation: trade.reconciliation,
              settlement: { ...(trade.settlement || {}), nft: { txid: status.txid, explorerUrl }, tokenisedAt: new Date().toISOString() },
            })
          }
        }
      }
    }

    res.json({ success: true, ...status })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE ROUTES  (auth required)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/trade', requireAuth, tradeLimiter, (req, res) => {
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
    userId:              req.userId,
    counterpartyName:    counterpartyName.trim(),
    counterpartyAddress: counterpartyAddress.trim(),
    totalValue:          numericValue,
    dueDate,
    createdAt: new Date().toISOString(),
  })

  console.log(`Trade created: ${id}`)
  res.status(201).json({ success: true, trade })
})

app.get('/trades', requireAuth, (req, res) => {
  const trades = db.getTradesByUser(req.userId)
  res.json({ success: true, trades })
})

// POST /trade/:id/sign-reconcile — build reconciliation TX and return XUMM payload
app.post('/trade/:id/sign-reconcile', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })

  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  const { yourShare, invoiceHash } = req.body
  if (yourShare === undefined)
    return res.status(400).json({ error: 'yourShare is required' })

  const payload  = JSON.stringify({ tradeId: trade.id, totalCost: trade.totalValue, yourShare: parseFloat(yourShare), invoiceHash })
  const txjson   = {
    TransactionType: 'Payment',
    Account:         user.xrplAddress,
    Destination:     trade.counterpartyAddress,
    Amount:          '1',
    Memos: [{ Memo: {
      MemoType: Buffer.from('TradeFlow/Reconciliation', 'utf8').toString('hex').toUpperCase(),
      MemoData: Buffer.from(payload,                   'utf8').toString('hex').toUpperCase(),
    }}],
  }

  try {
    const result = await xumm.createPayload(txjson, { returnUrl: `${process.env.APP_URL || `http://localhost:${port}`}/` })
    db.saveXummPayload({ uuid: result.uuid, tradeId: trade.id, action: 'reconcile', userId: req.userId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /trade/:id/sign-settle — build settlement TX and return XUMM payload
app.post('/trade/:id/sign-settle', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })

  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'
  const amount = trade.reconciliation ? String(trade.reconciliation.yourShare) : String(trade.totalValue)

  const txjson = {
    TransactionType: 'Payment',
    Account:         user.xrplAddress,
    Destination:     trade.counterpartyAddress,
    Amount:          { currency: '524C555344000000000000000000000000000000', issuer: RLUSD_ISSUER, value: amount },
    Memos: [{ Memo: {
      MemoType: Buffer.from('TradeFlow/TradeID', 'utf8').toString('hex').toUpperCase(),
      MemoData: Buffer.from(trade.id,            'utf8').toString('hex').toUpperCase(),
    }}],
  }

  try {
    const result = await xumm.createPayload(txjson, { returnUrl: `${process.env.APP_URL || `http://localhost:${port}`}/` })
    db.saveXummPayload({ uuid: result.uuid, tradeId: trade.id, action: 'settle', userId: req.userId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// TRUST LINE ROUTES  (auth required)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/trust-lines/:address', requireAuth, async (req, res) => {
  const { address } = req.params
  if (!xrpl.isValidAddress(address))
    return res.status(400).json({ error: 'Invalid XRPL address' })
  try {
    const c        = await getClient()
    const response = await c.request({ command: 'account_lines', account: address, ledger_index: 'validated' })
    const lines    = response.result.lines.map(line => ({
      currency: line.currency, issuer: line.account, balance: line.balance,
      limit: line.limit, limitPeer: line.limit_peer,
    }))
    res.json({ success: true, address, trustLines: lines })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /trust-line/sign — return XUMM payload for TrustSet (no seed needed)
app.post('/trust-line/sign', requireAuth, async (req, res) => {
  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'
  const txjson = {
    TransactionType: 'TrustSet',
    Account: user.xrplAddress,
    LimitAmount: {
      currency: '524C555344000000000000000000000000000000',
      issuer:   RLUSD_ISSUER,
      value:    String(req.body.limit || '1000000'),
    },
  }
  try {
    const result = await xumm.createPayload(txjson, { returnUrl: `${process.env.APP_URL || `http://localhost:${port}`}/` })
    db.saveXummPayload({ uuid: result.uuid, tradeId: null, action: 'TrustSet', userId: req.userId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY / SERVER-WALLET ROUTES  (testnet / demo use only)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /settle — direct payment using server wallet from .env (testnet demos)
app.post('/settle', payLimiter, async (req, res) => {
  const { amount, currency } = req.body
  const walletSeed           = process.env.XRPL_WALLET_SEED
  const destinationAddress   = process.env.XRPL_DESTINATION_ADDRESS

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    return res.status(400).json({ error: 'amount must be a positive number.' })
  if (!walletSeed || !destinationAddress)
    return res.status(503).json({ error: 'Server wallet not configured (XRPL_WALLET_SEED / XRPL_DESTINATION_ADDRESS missing from .env)' })

  try {
    const result = await sendPayment(walletSeed, destinationAddress, amount, currency || 'XRP')
    res.json({ success: true, hash: result.hash, explorerUrl: result.explorerUrl })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', network: 'XRPL Testnet', timestamp: new Date().toISOString() })
})

// ─── Core payment helper (server wallet, not user wallet) ─────────────────────
async function sendPayment(seed, destination, amount, currency = 'XRP', tradeId = null) {
  const c            = await getClient()
  const wallet       = xrpl.Wallet.fromSeed(seed)
  const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'

  const paymentAmount = currency === 'XRP'
    ? xrpl.xrpToDrops(amount)
    : { currency: '524C555344000000000000000000000000000000', issuer: RLUSD_ISSUER, value: String(amount) }

  const tx = {
    TransactionType: 'Payment',
    Account: wallet.address, Destination: destination, Amount: paymentAmount,
    ...(tradeId && { Memos: [{ Memo: {
      MemoType: Buffer.from('TradeFlow/TradeID', 'utf8').toString('hex').toUpperCase(),
      MemoData: Buffer.from(tradeId,             'utf8').toString('hex').toUpperCase(),
    }}] }),
  }

  const prepared = await c.autofill(tx)
  const signed   = wallet.sign(prepared)
  const response = await c.submitAndWait(signed.tx_blob)
  return {
    hash: response.result.hash, status: response.result.meta.TransactionResult,
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
app.listen(port, () => console.log(`TradeFlow server running on port ${port}`))
