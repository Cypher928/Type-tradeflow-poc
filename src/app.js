'use strict'

const express    = require('express')
const xrpl       = require('xrpl')
const crypto     = require('crypto')
const path       = require('path')
const cors       = require('cors')
const helmet     = require('helmet')
const rateLimit  = require('express-rate-limit')
const multer     = require('multer')
const db         = require('./db')
const { hashPassword, verifyPassword, signToken, requireAuth } = require('./auth')
const xumm       = require('./xumm')
const email      = require('./email')
const compliance = require('./compliance')

const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const app  = express()
const port = process.env.PORT || 3000

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })) // CSP disabled — inline scripts in index.html

// ─── CORS ─────────────────────────────────────────────────────────────────────
// When ALLOWED_ORIGINS is not set, allow all origins (suitable for Vercel PoC
// deployments where the exact URL is not known at build time). Set
// ALLOWED_ORIGINS=https://your-domain.com in production to restrict access.
const _rawOrigins = process.env.ALLOWED_ORIGINS
const allowedOrigins = _rawOrigins ? _rawOrigins.split(',').map(s => s.trim()) : []
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)               // non-browser / server-to-server
    if (allowedOrigins.length === 0) return cb(null, true)  // no allowlist — open
    if (allowedOrigins.includes(origin)) return cb(null, true)
    console.warn(`[CORS] blocked origin: ${origin}`)
    cb(new Error(`CORS: origin ${origin} not in ALLOWED_ORIGINS`))
  }
}))

// ─── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter  = rateLimit({ windowMs: 15 * 60_000, max: 20,  standardHeaders: true, legacyHeaders: false })
const tradeLimiter = rateLimit({ windowMs: 60_000,       max: 30,  standardHeaders: true, legacyHeaders: false })
const payLimiter   = rateLimit({ windowMs: 60_000,       max: 10,  standardHeaders: true, legacyHeaders: false })

app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

// ─── XRPL Client with failover ────────────────────────────────────────────────
const XRPL_NETWORK = process.env.XRPL_NETWORK || 'testnet'
// Default testnet nodes ordered by reliability in cloud/serverless environments.
// wss://testnet.xrpl-labs.com runs on port 443 (always open).
// wss://s.altnet.rippletest.net:51233 uses port 51233 which is often blocked by
// cloud firewalls (Vercel, AWS Lambda, etc.).  Set XRPL_NODES env var to override.
const XRPL_NODES_DEFAULT = XRPL_NETWORK === 'mainnet'
  ? 'wss://xrplcluster.com,wss://s1.ripple.com,wss://s2.ripple.com'
  : 'wss://testnet.xrpl-labs.com,wss://s.altnet.rippletest.net:51233'
const XRPL_NODES = (process.env.XRPL_NODES || process.env.XRPL_NODE || XRPL_NODES_DEFAULT)
  .split(',').map(s => s.trim()).filter(Boolean)
const explorerBase = XRPL_NETWORK === 'mainnet'
  ? 'https://livenet.xrpl.org/transactions'
  : 'https://testnet.xrpl.org/transactions'

let _client      = null
let _clientIndex = 0

async function getClient() {
  if (_client && _client.isConnected()) return _client

  for (let i = 0; i < XRPL_NODES.length; i++) {
    const url = XRPL_NODES[(_clientIndex + i) % XRPL_NODES.length]
    console.log(`[xrpl] connecting to ${url} (attempt ${i + 1}/${XRPL_NODES.length})`)
    try {
      const c = new xrpl.Client(url)
      await Promise.race([
        c.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout (8s)')), 8000)),
      ])
      _clientIndex = (_clientIndex + i) % XRPL_NODES.length
      _client      = c
      console.log(`[xrpl] connected: ${url}`)
      return c
    } catch (err) {
      console.error(`[xrpl] node ${url} failed: ${err.message}`)
    }
  }
  throw new Error(`All XRPL nodes unreachable: [${XRPL_NODES.join(', ')}]`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /auth/register
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { email: emailAddr, password } = req.body
    console.log(`[register] attempt — email=${emailAddr ? emailAddr.slice(0, 3) + '***' : 'MISSING'} password_len=${password ? password.length : 'MISSING'}`)

    if (!emailAddr || !password) {
      console.log('[register] FAIL: missing email or password')
      return res.status(400).json({ error: 'email and password are required', field: !emailAddr ? 'email' : 'password' })
    }
    if (password.length < 8) {
      console.log(`[register] FAIL: password too short (${password.length} chars)`)
      return res.status(400).json({ error: 'password must be at least 8 characters', field: 'password', rule: 'minLength:8' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddr)) {
      console.log(`[register] FAIL: invalid email format — ${emailAddr}`)
      return res.status(400).json({ error: 'invalid email address', field: 'email', rule: 'emailFormat' })
    }

    console.log('[register] validation passed — checking duplicate')
    if (db.getUserByEmail(emailAddr.toLowerCase())) {
      console.log('[register] FAIL: duplicate email')
      return res.status(409).json({ error: 'an account with that email already exists', field: 'email', rule: 'unique' })
    }

    console.log('[register] hashing password')
    const passwordHash = await hashPassword(password)

    console.log('[register] creating user in DB')
    const userId = crypto.randomUUID()
    const user = db.createUser({ id: userId, email: emailAddr.toLowerCase(), passwordHash })

    console.log(`[register] signing token for userId=${userId}`)
    const token = signToken(user.id)

    console.log('[register] SUCCESS')
    res.status(201).json({ success: true, token, user })
  } catch (err) {
    console.error('[register] UNHANDLED ERROR:', err.message, err.stack)
    res.status(500).json({ error: err.message, step: 'register' })
  }
})

// POST /auth/login
app.post('/auth/login', authLimiter, async (req, res) => {
  const { email: emailAddr, password } = req.body
  if (!emailAddr || !password)
    return res.status(400).json({ error: 'email and password are required' })

  const record = db.getUserByEmail(emailAddr.toLowerCase())
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
  if (!xrplAddress)
    return res.status(400).json({ error: 'xrplAddress is required', field: 'xrplAddress' })
  if (!xrpl.isValidAddress(xrplAddress))
    return res.status(400).json({ error: 'Not a valid XRPL address — must start with "r" (e.g. rXXX…)', field: 'xrplAddress' })

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

      if (record.trade_id) {
        const trade = db.getTradeById(record.trade_id)
        if (trade) {
          const explorerUrl = `${explorerBase}/${status.txid}`
          const now = new Date().toISOString()

          // Verify the transaction succeeded on-ledger before advancing state
          let onChainTx = null
          try {
            const c = await getClient()
            const txResp = await c.request({ command: 'tx', transaction: status.txid })
            onChainTx = txResp.result
          } catch (err) {
            console.warn(`[ledger-verify] Could not fetch ${status.txid}: ${err.message}`)
          }
          const ledgerResult = onChainTx?.meta?.TransactionResult
          if (ledgerResult && ledgerResult !== 'tesSUCCESS') {
            console.warn(`[ledger-verify] TX ${status.txid} failed on-ledger: ${ledgerResult}`)
            return res.json({ success: true, ...status, ledgerFailed: true, ledgerResult })
          }

          if (record.action === 'reconcile') {
            db.updateTrade(trade.id, {
              status:        'reconciled',
              reconciliation: { onChain: { hash: status.txid, explorerUrl }, recordedAt: now },
              escrow:     trade.escrow,
              settlement: trade.settlement,
              nft:        trade.nft,
            })
            db.logAudit({ tradeId: trade.id, userId: record.user_id, action: 'reconciled', txid: status.txid })
            notifyCounterparty(trade, 'reconciled', explorerUrl)

          } else if (record.action === 'escrow_create') {

            // Reuse the already-fetched TX for the Sequence needed by EscrowFinish
            const sequence = onChainTx?.Sequence ?? null

            db.updateTrade(trade.id, {
              status: 'escrowed',
              reconciliation: trade.reconciliation,
              escrow: { txid: status.txid, explorerUrl, owner: status.account, sequence, createdAt: now },
              settlement: trade.settlement,
              nft:        trade.nft,
            })
            db.logAudit({ tradeId: trade.id, userId: record.user_id, action: 'escrowed', txid: status.txid })
            notifyCounterparty(trade, 'escrowed', explorerUrl)

          } else if (record.action === 'escrow_finish') {
            db.updateTrade(trade.id, {
              status: 'settled',
              reconciliation: trade.reconciliation,
              escrow:  { ...trade.escrow, finishedTxid: status.txid, finishedExplorerUrl: explorerUrl, finishedAt: now },
              settlement: { onChain: { hash: status.txid, explorerUrl }, settledAt: now },
              nft:        trade.nft,
            })
            db.logAudit({ tradeId: trade.id, userId: record.user_id, action: 'settled (escrow finish)', txid: status.txid })
            notifyCounterparty(trade, 'settled', explorerUrl)

          } else if (record.action === 'settle') {
            db.updateTrade(trade.id, {
              status: 'settled',
              reconciliation: trade.reconciliation,
              escrow:     trade.escrow,
              settlement: { onChain: { hash: status.txid, explorerUrl }, settledAt: now },
              nft:        trade.nft,
            })
            db.logAudit({ tradeId: trade.id, userId: record.user_id, action: 'settled (direct)', txid: status.txid })
            notifyCounterparty(trade, 'settled', explorerUrl)

          } else if (record.action === 'tokenise') {
            db.updateTrade(trade.id, {
              status: 'tokenised',
              reconciliation: trade.reconciliation,
              escrow:     trade.escrow,
              settlement: trade.settlement,
              nft:        { txid: status.txid, explorerUrl, tokenisedAt: now },
            })
            db.logAudit({ tradeId: trade.id, userId: record.user_id, action: 'tokenised', txid: status.txid })
            notifyCounterparty(trade, 'tokenised', explorerUrl)
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

app.post('/trade', requireAuth, tradeLimiter, async (req, res) => {
  try {
    const { counterpartyName, counterpartyAddress, totalValue, dueDate } = req.body

    if (!counterpartyName)
      return res.status(400).json({ error: 'Counterparty name is required', field: 'counterpartyName' })
    if (!counterpartyAddress)
      return res.status(400).json({ error: 'Counterparty XRPL address is required', field: 'counterpartyAddress' })
    if (!totalValue)
      return res.status(400).json({ error: 'Total value is required', field: 'totalValue' })
    if (!dueDate)
      return res.status(400).json({ error: 'Due date is required', field: 'dueDate' })

    if (!xrpl.isValidAddress(counterpartyAddress.trim()))
      return res.status(400).json({ error: 'Counterparty XRPL address is not valid — must start with "r" and be 25–35 characters', field: 'counterpartyAddress' })

    const numericValue = parseFloat(totalValue)
    if (isNaN(numericValue) || numericValue <= 0)
      return res.status(400).json({ error: 'Total value must be a positive number', field: 'totalValue' })

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

    db.logAudit({ tradeId: id, userId: req.userId, action: 'trade_created', detail: `counterparty=${counterpartyAddress.trim()} value=${numericValue} due=${dueDate}` })
    console.log(`[trade] created: ${id} counterparty=${counterpartyAddress.trim()} value=${numericValue}`)
    res.status(201).json({ success: true, trade })
  } catch (err) {
    console.error('[trade] create error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
})

// GET /trade/:id — single trade with creator email
app.get('/trade/:id', requireAuth, (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })
  const creator = db.getUserById(trade.userId)
  res.json({ success: true, trade: { ...trade, creatorEmail: creator?.email || null } })
})

// GET /trades — paginated trade list with creator emails
app.get('/trades', requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 100)
  const offset = Math.max(parseInt(req.query.offset) || 0,  0)
  const trades = db.getTradesByUserOrCounterpartyPaged(req.userId, limit, offset)
  const total  = db.countTradesByUserOrCounterparty(req.userId)

  const userIds = [...new Set(trades.map(t => t.userId).filter(Boolean))]
  const userMap = {}
  for (const uid of userIds) {
    const u = db.getUserById(uid)
    if (u) userMap[uid] = u.email
  }
  const enriched = trades.map(t => ({ ...t, creatorEmail: userMap[t.userId] || null }))

  res.json({ success: true, trades: enriched, total, limit, offset })
})

// POST /trade/:id/advance-status — demo/test-only manual status advancement (no XUMM required)
const STATUS_SEQUENCE = ['active', 'reconciled', 'escrowed', 'settled', 'tokenised']
app.post('/trade/:id/advance-status', requireAuth, (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })

  const currentIdx = STATUS_SEQUENCE.indexOf(trade.status)
  if (currentIdx === -1 || currentIdx === STATUS_SEQUENCE.length - 1)
    return res.status(400).json({ error: `Trade is already at final status: ${trade.status}` })

  const nextStatus = STATUS_SEQUENCE[currentIdx + 1]
  const now = new Date().toISOString()

  const patch = {
    status:        nextStatus,
    reconciliation: trade.reconciliation,
    escrow:         trade.escrow,
    settlement:     trade.settlement,
    nft:            trade.nft,
  }

  if (nextStatus === 'reconciled' && !patch.reconciliation)
    patch.reconciliation = { simulated: true, recordedAt: now }
  if (nextStatus === 'escrowed' && !patch.escrow)
    patch.escrow = { simulated: true, createdAt: now }
  if (nextStatus === 'settled' && !patch.settlement)
    patch.settlement = { simulated: true, settledAt: now }
  if (nextStatus === 'tokenised' && !patch.nft)
    patch.nft = { simulated: true, tokenisedAt: now }

  const updated = db.updateTrade(trade.id, patch)
  db.logAudit({ tradeId: trade.id, userId: req.userId, action: `simulated_${nextStatus}`, detail: 'manual advance (demo mode)' })
  console.log(`[trade] manual advance: ${trade.id} ${trade.status} → ${nextStatus}`)
  res.json({ success: true, trade: updated })
})

// POST /trade/:id/sign-reconcile — build reconciliation TX and return XUMM payload
app.post('/trade/:id/sign-reconcile', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })

  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  const { yourShare, invoiceHash } = req.body
  if (yourShare === undefined)
    return res.status(400).json({ error: 'yourShare is required' })

  // N-3/N-4: validate yourShare is numeric and within trade bounds
  const numericShare = parseFloat(yourShare)
  if (isNaN(numericShare) || numericShare <= 0)
    return res.status(400).json({ error: 'yourShare must be a positive number' })
  if (numericShare > trade.totalValue)
    return res.status(400).json({ error: `yourShare cannot exceed the trade total value of ${trade.totalValue}` })

  const payload  = JSON.stringify({ tradeId: trade.id, totalCost: trade.totalValue, yourShare: numericShare, invoiceHash })
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

// POST /trade/:id/sign-escrow — build EscrowCreate TX and return XUMM payload
app.post('/trade/:id/sign-escrow', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })
  if (trade.status !== 'reconciled') return res.status(400).json({ error: 'Trade must be reconciled before creating an escrow' })

  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  const travelCheckEscrow = compliance.checkTravelRule(trade.totalValue, user.kycStatus)
  if (travelCheckEscrow.blocked) return res.status(403).json({ error: travelCheckEscrow.reason })
  compliance.amlLog({ userId: req.userId, tradeId: trade.id, amountUsd: trade.totalValue, action: 'sign-escrow' })

  const { xrpAmount, releaseHours } = req.body
  if (!xrpAmount || !releaseHours)
    return res.status(400).json({ error: 'xrpAmount and releaseHours are required' })

  const RIPPLE_EPOCH_OFFSET = 946684800
  const releaseTime = Math.floor(Date.now() / 1000) + (Number(releaseHours) * 3600) - RIPPLE_EPOCH_OFFSET

  const txjson = {
    TransactionType: 'EscrowCreate',
    Account:         user.xrplAddress,
    Destination:     trade.counterpartyAddress,
    Amount:          String(Math.round(Number(xrpAmount) * 1_000_000)), // drops
    FinishAfter:     releaseTime,
    Memos: [{ Memo: {
      MemoType: Buffer.from('TradeFlow/TradeID', 'utf8').toString('hex').toUpperCase(),
      MemoData: Buffer.from(trade.id,            'utf8').toString('hex').toUpperCase(),
    }}],
  }

  try {
    const result = await xumm.createPayload(txjson, { returnUrl: `${process.env.APP_URL || `http://localhost:${port}`}/` })
    db.saveXummPayload({ uuid: result.uuid, tradeId: trade.id, action: 'escrow_create', userId: req.userId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /trade/:id/sign-finish-escrow — build EscrowFinish TX and return XUMM payload
app.post('/trade/:id/sign-finish-escrow', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })
  if (trade.status !== 'escrowed' || !trade.escrow)
    return res.status(400).json({ error: 'No active escrow found for this trade' })

  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  const txjson = {
    TransactionType: 'EscrowFinish',
    Account:         user.xrplAddress,
    Owner:           trade.escrow.owner,
    OfferSequence:   trade.escrow.sequence,
  }

  try {
    const result = await xumm.createPayload(txjson, { returnUrl: `${process.env.APP_URL || `http://localhost:${port}`}/` })
    db.saveXummPayload({ uuid: result.uuid, tradeId: trade.id, action: 'escrow_finish', userId: req.userId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /trade/:id/sign-tokenise — build NFTokenMint TX and return XUMM payload
app.post('/trade/:id/sign-tokenise', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })
  if (trade.status !== 'settled') return res.status(400).json({ error: 'Trade must be settled before tokenising' })

  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  const travelCheckToken = compliance.checkTravelRule(trade.totalValue, user.kycStatus)
  if (travelCheckToken.blocked) return res.status(403).json({ error: travelCheckToken.reason })
  compliance.amlLog({ userId: req.userId, tradeId: trade.id, amountUsd: trade.totalValue, action: 'sign-tokenise' })

  const metadata = JSON.stringify({
    type:          'TradeFinanceInvoice',
    tradeId:       trade.id,
    invoiceAmount: trade.totalValue,
    dueDate:       trade.dueDate,
    platform:      'TradeFlow Ledger',
  })

  const ENABLE_MPT = process.env.ENABLE_MPT === 'true'
  const txjson = ENABLE_MPT
    // MPTokenIssuanceCreate — requires MPToken amendment on-ledger (mainnet path)
    ? {
        TransactionType:  'MPTokenIssuanceCreate',
        Account:          user.xrplAddress,
        AssetScale:       2,
        MaximumAmount:    String(Math.round(trade.totalValue * 100)), // cents
        Flags:            64, // tfMPTCanTransfer
        Metadata:         Buffer.from(metadata, 'utf8').toString('hex').toUpperCase(),
      }
    // NFTokenMint — current testnet path
    : {
        TransactionType: 'NFTokenMint',
        Account:         user.xrplAddress,
        NFTokenTaxon:    0,
        Flags:           8, // tfTransferable
        URI:             Buffer.from(metadata, 'utf8').toString('hex').toUpperCase(),
        Memos: [{ Memo: {
          MemoType: Buffer.from('TradeFlow/InvoiceTokenization', 'utf8').toString('hex').toUpperCase(),
          MemoData: Buffer.from(trade.id,                       'utf8').toString('hex').toUpperCase(),
        }}],
      }

  try {
    const result = await xumm.createPayload(txjson, { returnUrl: `${process.env.APP_URL || `http://localhost:${port}`}/` })
    db.saveXummPayload({ uuid: result.uuid, tradeId: trade.id, action: 'tokenise', userId: req.userId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /trade/:id/sign-settle — build settlement TX and return XUMM payload
app.post('/trade/:id/sign-settle', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })

  const user = db.getUserById(req.userId)
  if (!user?.xrplAddress)
    return res.status(400).json({ error: 'Link an XRPL address to your account first via POST /auth/wallet' })

  // Travel Rule / AML compliance check
  const amountUsd = trade.reconciliation?.yourShare ?? trade.totalValue
  const travelCheck = compliance.checkTravelRule(amountUsd, user.kycStatus)
  if (travelCheck.blocked) return res.status(403).json({ error: travelCheck.reason })
  compliance.amlLog({ userId: req.userId, tradeId: trade.id, amountUsd, action: 'sign-settle' })

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
// PHASE 3: INVITES · DOCUMENTS · AUDIT TRAIL · KYC
// ═══════════════════════════════════════════════════════════════════════════════

// POST /trade/:id/invite — generate invite link and optionally email the counterparty
app.post('/trade/:id/invite', requireAuth, async (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId) return res.status(403).json({ error: 'Only the trade creator can invite a counterparty' })

  const { inviteeEmail: inviteeAddr } = req.body
  const token     = crypto.randomBytes(20).toString('hex')
  const appUrl    = process.env.APP_URL || `http://localhost:${port}`
  const inviteUrl = `${appUrl}/?invite=${token}`

  db.createInvite({ token, tradeId: trade.id, inviteeEmail: inviteeAddr || null, invitedBy: req.userId })
  db.logAudit({ tradeId: trade.id, userId: req.userId, action: 'invite_created', detail: inviteeAddr || 'link only' })

  if (inviteeAddr) {
    const inviter = db.getUserById(req.userId)
    await email.tradeInvite({
      to:           inviteeAddr,
      inviterEmail: inviter.email,
      tradeName:    `${trade.id} — ${trade.counterpartyName}`,
      tradeValue:   trade.totalValue,
      inviteUrl,
    })
  }

  res.json({ success: true, inviteUrl, token })
})

// GET /invite/:token — look up invite details (public, used by frontend)
app.get('/invite/:token', (req, res) => {
  const invite = db.getInvite(req.params.token)
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired' })
  if (invite.accepted_at) return res.status(410).json({ error: 'Invite already accepted' })

  const trade = db.getTradeById(invite.trade_id)
  res.json({
    success: true,
    invite: {
      token:        invite.token,
      inviteeEmail: invite.invitee_email,
      tradeId:      invite.trade_id,
      tradeName:    trade ? `${trade.id} — ${trade.counterpartyName}` : invite.trade_id,
      tradeValue:   trade?.totalValue,
    }
  })
})

// POST /invite/:token/accept — accept invite (must be logged in)
app.post('/invite/:token/accept', requireAuth, (req, res) => {
  const invite = db.getInvite(req.params.token)
  if (!invite) return res.status(404).json({ error: 'Invite not found' })
  if (invite.accepted_at) return res.status(410).json({ error: 'Invite already accepted' })

  db.acceptInvite(invite.token)
  db.setCounterparty(invite.trade_id, req.userId)
  db.logAudit({ tradeId: invite.trade_id, userId: req.userId, action: 'counterparty_joined' })

  const trade = db.getTradeById(invite.trade_id)
  res.json({ success: true, trade })
})

// POST /trade/:id/document — upload a document; store its SHA-256 hash
app.post('/trade/:id/document', requireAuth, upload.single('file'), (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })

  let hash, filename, sizeBytes

  if (req.file) {
    hash      = crypto.createHash('sha256').update(req.file.buffer).digest('hex')
    filename  = req.file.originalname
    sizeBytes = req.file.size
  } else if (req.body.hash) {
    hash      = req.body.hash
    filename  = req.body.filename || null
    sizeBytes = req.body.sizeBytes ? parseInt(req.body.sizeBytes) : null
  } else {
    return res.status(400).json({ error: 'Provide a file upload or a hash' })
  }

  const doc = db.addDocument({ id: crypto.randomUUID(), tradeId: trade.id, userId: req.userId, filename, hash, sizeBytes })
  db.logAudit({ tradeId: trade.id, userId: req.userId, action: 'document_added', detail: `${filename || 'untitled'} — SHA-256: ${hash}` })

  res.status(201).json({ success: true, document: doc })
})

// GET /trade/:id/documents — list documents attached to a trade
app.get('/trade/:id/documents', requireAuth, (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })
  res.json({ success: true, documents: db.getDocuments(req.params.id) })
})

// GET /trade/:id/audit — full audit log for a trade
app.get('/trade/:id/audit', requireAuth, (req, res) => {
  const trade = db.getTradeById(req.params.id)
  if (!trade) return res.status(404).json({ error: 'Trade not found' })
  if (trade.userId !== req.userId && trade.counterpartyUserId !== req.userId)
    return res.status(403).json({ error: 'Forbidden' })
  res.json({ success: true, log: db.getAuditLog(req.params.id) })
})

// GET /kyc/status — current user's KYC status
app.get('/kyc/status', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({
    success:   true,
    kycStatus: user.kycStatus,
    message:   user.kycStatus === 'pending'
      ? 'KYC verification is pending. Full KYC/KYB onboarding (Sumsub) will be required before mainnet.'
      : `KYC status: ${user.kycStatus}`
  })
})

// POST /kyc/webhook — KYC provider posts status updates here (Sumsub, Onfido, Persona, etc.)
// Set KYC_WEBHOOK_SECRET in .env; the provider signs the body with HMAC-SHA256.
app.post('/kyc/webhook', (req, res) => {
  const secret = process.env.KYC_WEBHOOK_SECRET
  if (secret) {
    const sig      = req.headers['x-kyc-signature'] || ''
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex')
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      return res.status(401).json({ error: 'Invalid webhook signature' })
  }
  const { userId, status } = req.body
  if (!userId || !['pending', 'verified', 'rejected'].includes(status))
    return res.status(400).json({ error: 'userId and status (pending|verified|rejected) required' })
  db.setKycStatus(userId, status)
  db.logAudit({ userId, action: 'kyc_status_updated', detail: status })
  compliance.amlLog({ userId, amountUsd: 0, action: `kyc_${status}` })
  res.json({ success: true })
})

// PATCH /admin/users/:id/kyc — manual KYC override, requires X-Admin-Secret header
app.patch('/admin/users/:id/kyc', (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret)
    return res.status(403).json({ error: 'Forbidden' })
  const { status } = req.body
  if (!['pending', 'verified', 'rejected'].includes(status))
    return res.status(400).json({ error: 'status must be pending, verified, or rejected' })
  db.setKycStatus(req.params.id, status)
  db.logAudit({ userId: req.params.id, action: 'kyc_manual_override', detail: status })
  compliance.amlLog({ userId: req.params.id, amountUsd: 0, action: `kyc_manual_${status}` })
  res.json({ success: true })
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

app.get('/health', async (_req, res) => {
  let xrpl = {
    connected:  false,
    node:       XRPL_NODES[_clientIndex] || XRPL_NODES[0] || null,
    nodeCount:  XRPL_NODES.length,
    nodes:      XRPL_NODES,
  }

  console.log(`[health] XRPL nodes configured: ${XRPL_NODES.join(', ')}`)

  try {
    const c = await Promise.race([
      getClient(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('health connect timeout (10s)')), 10000)),
    ])

    console.log('[health] requesting server_info')
    const resp = await c.request({ command: 'server_info' })
    const info = resp.result?.info ?? {}

    console.log(`[health] server_info OK — build=${info.build_version} ledger=${info.validated_ledger?.seq}`)

    xrpl = {
      connected:        true,
      node:             XRPL_NODES[_clientIndex],
      nodeCount:        XRPL_NODES.length,
      nodes:            XRPL_NODES,
      serverVersion:    info.build_version   ?? null,
      ledger:           info.validated_ledger?.seq ?? null,
      ledgerHash:       info.validated_ledger?.hash ?? null,
      serverState:      info.server_state   ?? null,
      completeLedgers:  info.complete_ledgers ?? null,
    }
  } catch (err) {
    console.error(`[health] XRPL unavailable: ${err.message}`)
    xrpl.error = err.message
  }

  res.json({
    status:     'ok',
    network:    XRPL_NETWORK,
    xrpl,
    db:         'ok',
    mptEnabled: process.env.ENABLE_MPT === 'true',
    uptime:     Math.floor(process.uptime()),
    timestamp:  new Date().toISOString(),
  })
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
    explorerUrl: `${explorerBase}/${response.result.hash}`,
  }
}

// ─── Email counterparty on trade status change ────────────────────────────────
async function notifyCounterparty(trade, status, explorerUrl) {
  if (!trade.counterpartyUserId) return
  const cp = db.getUserById(trade.counterpartyUserId)
  if (!cp?.email) return
  email.tradeStatusChanged({ to: cp.email, tradeId: trade.id, status, explorerUrl }).catch(() => {})
}

// ─── Global Express error handler ─────────────────────────────────────────────
// Catches errors passed via next(err) from middleware (e.g. CORS, body-parser).
// Without this, Express returns an HTML 500 page which cannot be parsed as JSON.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[express-error] ${req.method} ${req.path} —`, err.message)
  res.status(err.status || 500).json({ error: err.message })
})

// ─── Expose XRPL disconnect for graceful shutdown ─────────────────────────────
app.shutdown = async function () {
  if (_client && _client.isConnected()) await _client.disconnect()
  db.close()
}

module.exports = app
