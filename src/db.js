'use strict'

const crypto = require('crypto')
const path   = require('path')
const fs     = require('fs')

// ─── Mode detection ───────────────────────────────────────────────────────────
// TURSO_URL + TURSO_AUTH_TOKEN  →  persistent Turso cloud DB via @libsql/client
// (No env vars)                 →  local better-sqlite3 file (dev / CI)
//
// All exported functions are async so route handlers use one code path
// regardless of mode.  In local mode the synchronous SQLite operations are
// wrapped in async functions — they resolve on the next microtask.

const TURSO_URL   = process.env.TURSO_URL
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN
const USE_TURSO   = Boolean(TURSO_URL)

// ─── Local SQLite ─────────────────────────────────────────────────────────────

let _sqlite = null

function getSqlite() {
  if (_sqlite) return _sqlite
  const DEFAULT = path.join(__dirname, '../data/tradeflow.db')
  let dbPath = process.env.DB_PATH || DEFAULT
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }) }
    catch { dbPath = '/tmp/tradeflow.db' }
  }
  const Database = require('better-sqlite3')
  _sqlite = new Database(dbPath)
  _sqlite.pragma('journal_mode = WAL')
  _sqlite.pragma('foreign_keys = ON')
  return _sqlite
}

// ─── Turso / libsql ───────────────────────────────────────────────────────────

let _libsql = null

function getLibsql() {
  if (!_libsql) {
    const { createClient } = require('@libsql/client')
    _libsql = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
  }
  return _libsql
}

// Convert a libsql ResultSet row (array-like with column names) to a plain object
function libRow(columns, row) {
  const obj = {}
  for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i]
  return obj
}

// ─── Low-level helpers ────────────────────────────────────────────────────────
// params: array  → positional ?  placeholders
// params: object → named      @name placeholders (both drivers support this)

async function dbRun(sql, params = []) {
  if (USE_TURSO) {
    const r = await getLibsql().execute({ sql, args: params })
    return { changes: r.rowsAffected }
  }
  const stmt = getSqlite().prepare(sql)
  return Array.isArray(params) ? stmt.run(...params) : stmt.run(params)
}

async function dbGet(sql, params = []) {
  if (USE_TURSO) {
    const r = await getLibsql().execute({ sql, args: params })
    return r.rows[0] ? libRow(r.columns, r.rows[0]) : null
  }
  const stmt = getSqlite().prepare(sql)
  return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) ?? null
}

async function dbAll(sql, params = []) {
  if (USE_TURSO) {
    const r = await getLibsql().execute({ sql, args: params })
    return r.rows.map(row => libRow(r.columns, row))
  }
  const stmt = getSqlite().prepare(sql)
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params)
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    xrpl_address  TEXT,
    kyc_status    TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trades (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT,
    counterparty_user_id    TEXT,
    counterparty_name       TEXT NOT NULL,
    counterparty_address    TEXT NOT NULL,
    total_value             REAL NOT NULL,
    due_date                TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'active',
    created_at              TEXT NOT NULL,
    updated_at              TEXT,
    reconciliation          TEXT,
    escrow                  TEXT,
    settlement              TEXT,
    nft                     TEXT,
    FOREIGN KEY (user_id)              REFERENCES users(id),
    FOREIGN KEY (counterparty_user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS xumm_payloads (
    uuid       TEXT PRIMARY KEY,
    trade_id   TEXT,
    action     TEXT NOT NULL,
    user_id    TEXT,
    resolved   INTEGER NOT NULL DEFAULT 0,
    txid       TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    token         TEXT PRIMARY KEY,
    trade_id      TEXT NOT NULL,
    invitee_email TEXT,
    invited_by    TEXT NOT NULL,
    accepted_at   TEXT,
    created_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    id         TEXT PRIMARY KEY,
    trade_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    filename   TEXT,
    hash       TEXT NOT NULL,
    size_bytes INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT PRIMARY KEY,
    trade_id   TEXT NOT NULL,
    user_id    TEXT,
    action     TEXT NOT NULL,
    detail     TEXT,
    txid       TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS aml_log (
    id          TEXT PRIMARY KEY,
    ts          TEXT NOT NULL,
    user_id     TEXT,
    trade_id    TEXT,
    amount_usd  REAL,
    action      TEXT NOT NULL,
    flag        TEXT,
    ledger_txid TEXT
  )`,
]

const MIGRATIONS = [
  `ALTER TABLE trades ADD COLUMN escrow TEXT`,
  `ALTER TABLE trades ADD COLUMN nft TEXT`,
  `ALTER TABLE trades ADD COLUMN counterparty_user_id TEXT`,
  `ALTER TABLE trades ADD COLUMN updated_at TEXT`,
  `ALTER TABLE users  ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'pending'`,
]

let _initPromise = null

async function initDb() {
  if (USE_TURSO) {
    const client = getLibsql()
    for (const sql of SCHEMA_STMTS) await client.execute(sql)
    for (const sql of MIGRATIONS) { try { await client.execute(sql) } catch {} }
  } else {
    const db = getSqlite()
    // better-sqlite3 exec() handles multi-statement; run each separately for clarity
    for (const sql of SCHEMA_STMTS) db.exec(sql)
    for (const sql of MIGRATIONS) { try { db.exec(sql) } catch {} }
  }
}

function ready() {
  if (!_initPromise) _initPromise = initDb()
  return _initPromise
}

// Kick off schema init immediately so it's done before any request hits.
// In local mode this runs synchronously (no awaits in the SQLite path).
ready()

// ─── Row mappers ──────────────────────────────────────────────────────────────

function rowToUser(row) {
  if (!row) return null
  return { id: row.id, email: row.email, xrplAddress: row.xrpl_address, kycStatus: row.kyc_status || 'pending', createdAt: row.created_at }
}

function rowToTrade(row) {
  if (!row) return null
  return {
    id:                   row.id,
    userId:               row.user_id,
    counterpartyUserId:   row.counterparty_user_id || null,
    counterpartyName:     row.counterparty_name,
    counterpartyAddress:  row.counterparty_address,
    totalValue:           row.total_value,
    dueDate:              row.due_date,
    status:               row.status,
    createdAt:            row.created_at,
    updatedAt:            row.updated_at || null,
    reconciliation:       row.reconciliation ? JSON.parse(row.reconciliation) : null,
    escrow:               row.escrow         ? JSON.parse(row.escrow)         : null,
    settlement:           row.settlement     ? JSON.parse(row.settlement)     : null,
    nft:                  row.nft            ? JSON.parse(row.nft)            : null,
  }
}

// ─── Exported API (all async) ─────────────────────────────────────────────────

module.exports = {
  // ── Users ──────────────────────────────────────────────────────────────────
  async createUser({ id, email, passwordHash }) {
    await ready()
    await dbRun(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (@id, @email, @passwordHash, @createdAt)',
      { id, email, passwordHash, createdAt: new Date().toISOString() }
    )
    return rowToUser(await dbGet('SELECT * FROM users WHERE id = ?', [id]))
  },

  async getUserByEmail(email) {
    await ready()
    const row = await dbGet('SELECT * FROM users WHERE email = ?', [email])
    if (!row) return null
    return { ...rowToUser(row), passwordHash: row.password_hash }
  },

  async getUserById(id) {
    await ready()
    return rowToUser(await dbGet('SELECT * FROM users WHERE id = ?', [id]))
  },

  async setWalletAddress(userId, xrplAddress) {
    await ready()
    await dbRun('UPDATE users SET xrpl_address = ? WHERE id = ?', [xrplAddress, userId])
    return rowToUser(await dbGet('SELECT * FROM users WHERE id = ?', [userId]))
  },

  // ── Trades ─────────────────────────────────────────────────────────────────
  async createTrade(trade) {
    await ready()
    await dbRun(
      `INSERT INTO trades (id, user_id, counterparty_name, counterparty_address, total_value, due_date, status, created_at)
       VALUES (@id, @userId, @counterpartyName, @counterpartyAddress, @totalValue, @dueDate, @status, @createdAt)`,
      { ...trade, status: 'active' }
    )
    return rowToTrade(await dbGet('SELECT * FROM trades WHERE id = ?', [trade.id]))
  },

  async getTradeById(id) {
    await ready()
    return rowToTrade(await dbGet('SELECT * FROM trades WHERE id = ?', [id]))
  },

  async getAllTrades() {
    await ready()
    return (await dbAll('SELECT * FROM trades ORDER BY created_at DESC')).map(rowToTrade)
  },

  async getTradesByUser(userId) {
    await ready()
    return (await dbAll('SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC', [userId])).map(rowToTrade)
  },

  async updateTrade(id, { status, reconciliation, escrow, settlement, nft }) {
    await ready()
    await dbRun(
      `UPDATE trades SET status = @status, reconciliation = @reconciliation, escrow = @escrow,
       settlement = @settlement, nft = @nft, updated_at = @updatedAt WHERE id = @id`,
      {
        id, status,
        updatedAt:      new Date().toISOString(),
        reconciliation: reconciliation ? JSON.stringify(reconciliation) : null,
        escrow:         escrow         ? JSON.stringify(escrow)         : null,
        settlement:     settlement     ? JSON.stringify(settlement)     : null,
        nft:            nft            ? JSON.stringify(nft)            : null,
      }
    )
    return rowToTrade(await dbGet('SELECT * FROM trades WHERE id = ?', [id]))
  },

  // ── XUMM payloads ──────────────────────────────────────────────────────────
  async saveXummPayload({ uuid, tradeId, action, userId }) {
    await ready()
    await dbRun(
      'INSERT INTO xumm_payloads (uuid, trade_id, action, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [uuid, tradeId || null, action, userId || null, new Date().toISOString()]
    )
  },

  async getXummPayload(uuid) {
    await ready()
    return dbGet('SELECT * FROM xumm_payloads WHERE uuid = ?', [uuid])
  },

  async resolveXummPayload(uuid, txid) {
    await ready()
    await dbRun('UPDATE xumm_payloads SET resolved = 1, txid = ? WHERE uuid = ?', [txid, uuid])
  },

  // ── Trades — counterparty / paginated ──────────────────────────────────────
  async getTradesByUserOrCounterparty(userId) {
    await ready()
    return (await dbAll(
      'SELECT * FROM trades WHERE user_id = ? OR counterparty_user_id = ? ORDER BY created_at DESC',
      [userId, userId]
    )).map(rowToTrade)
  },

  async getTradesByUserOrCounterpartyPaged(userId, limit, offset) {
    await ready()
    return (await dbAll(
      'SELECT * FROM trades WHERE user_id = ? OR counterparty_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [userId, userId, limit, offset]
    )).map(rowToTrade)
  },

  async countTradesByUserOrCounterparty(userId) {
    await ready()
    const row = await dbGet(
      'SELECT COUNT(*) as count FROM trades WHERE user_id = ? OR counterparty_user_id = ?',
      [userId, userId]
    )
    return row?.count ?? 0
  },

  async setCounterparty(tradeId, counterpartyUserId) {
    await ready()
    await dbRun('UPDATE trades SET counterparty_user_id = ? WHERE id = ?', [counterpartyUserId, tradeId])
  },

  // ── Invites ────────────────────────────────────────────────────────────────
  async createInvite({ token, tradeId, inviteeEmail, invitedBy }) {
    await ready()
    await dbRun(
      'INSERT INTO invites (token, trade_id, invitee_email, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [token, tradeId, inviteeEmail || null, invitedBy, new Date().toISOString()]
    )
    return this.getInvite(token)
  },

  async getInvite(token) {
    await ready()
    return dbGet('SELECT * FROM invites WHERE token = ?', [token])
  },

  async acceptInvite(token) {
    await ready()
    await dbRun('UPDATE invites SET accepted_at = ? WHERE token = ?', [new Date().toISOString(), token])
  },

  // ── Documents ──────────────────────────────────────────────────────────────
  async addDocument({ id, tradeId, userId, filename, hash, sizeBytes }) {
    await ready()
    await dbRun(
      'INSERT INTO documents (id, trade_id, user_id, filename, hash, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, tradeId, userId, filename || null, hash, sizeBytes || 0, new Date().toISOString()]
    )
    return dbGet('SELECT * FROM documents WHERE id = ?', [id])
  },

  async getDocuments(tradeId) {
    await ready()
    return dbAll('SELECT * FROM documents WHERE trade_id = ? ORDER BY created_at DESC', [tradeId])
  },

  // ── Audit log ──────────────────────────────────────────────────────────────
  async logAudit({ tradeId, userId, action, detail, txid }) {
    await ready()
    await dbRun(
      'INSERT INTO audit_log (id, trade_id, user_id, action, detail, txid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), tradeId || 'system', userId || null, action, detail || null, txid || null, new Date().toISOString()]
    )
  },

  async getAuditLog(tradeId) {
    await ready()
    return dbAll('SELECT * FROM audit_log WHERE trade_id = ? ORDER BY created_at ASC', [tradeId])
  },

  // ── AML log ───────────────────────────────────────────────────────────────
  async logAml({ userId, tradeId, amountUsd, action, flag, ledgerTxid }) {
    await ready()
    await dbRun(
      'INSERT INTO aml_log (id, ts, user_id, trade_id, amount_usd, action, flag, ledger_txid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), new Date().toISOString(), userId || null, tradeId || null, amountUsd ?? null, action, flag || null, ledgerTxid || null]
    )
  },

  async getAmlLog() {
    await ready()
    return dbAll('SELECT * FROM aml_log ORDER BY ts DESC')
  },

  // ── KYC ───────────────────────────────────────────────────────────────────
  async setKycStatus(userId, status) {
    await ready()
    await dbRun('UPDATE users SET kyc_status = ? WHERE id = ?', [status, userId])
  },

  close() {
    if (_sqlite) _sqlite.close()
    if (_libsql)  _libsql.close()
  },
}
