'use strict'

const crypto   = require('crypto')
const Database = require('better-sqlite3')
const path = require('path')
const fs   = require('fs')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/tradeflow.db')

const dataDir = path.dirname(DB_PATH)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    xrpl_address  TEXT,
    kyc_status    TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT,
    counterparty_user_id    TEXT,
    counterparty_name       TEXT NOT NULL,
    counterparty_address    TEXT NOT NULL,
    total_value             REAL NOT NULL,
    due_date                TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'active',
    created_at              TEXT NOT NULL,
    reconciliation          TEXT,
    escrow                  TEXT,
    settlement              TEXT,
    nft                     TEXT,
    FOREIGN KEY (user_id)              REFERENCES users(id),
    FOREIGN KEY (counterparty_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS xumm_payloads (
    uuid       TEXT PRIMARY KEY,
    trade_id   TEXT,
    action     TEXT NOT NULL,
    user_id    TEXT,
    resolved   INTEGER NOT NULL DEFAULT 0,
    txid       TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invites (
    token         TEXT PRIMARY KEY,
    trade_id      TEXT NOT NULL,
    invitee_email TEXT,
    invited_by    TEXT NOT NULL,
    accepted_at   TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id         TEXT PRIMARY KEY,
    trade_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    filename   TEXT,
    hash       TEXT NOT NULL,
    size_bytes INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT PRIMARY KEY,
    trade_id   TEXT NOT NULL,
    user_id    TEXT,
    action     TEXT NOT NULL,
    detail     TEXT,
    txid       TEXT,
    created_at TEXT NOT NULL
  );
`)

// Migrate existing DBs — ignore errors if columns already exist
for (const col of ['escrow TEXT', 'nft TEXT', 'counterparty_user_id TEXT']) {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`) } catch {}
}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_status TEXT NOT NULL DEFAULT \'pending\'') } catch {}

// ─── User statements ──────────────────────────────────────────────────────────
const userStmts = {
  insert:       db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (@id, @email, @passwordHash, @createdAt)'),
  findByEmail:  db.prepare('SELECT * FROM users WHERE email = ?'),
  findById:     db.prepare('SELECT * FROM users WHERE id = ?'),
  updateWallet: db.prepare('UPDATE users SET xrpl_address = ? WHERE id = ?'),
}

// ─── Trade statements ─────────────────────────────────────────────────────────
const tradeStmts = {
  insert:     db.prepare(`
    INSERT INTO trades (id, user_id, counterparty_name, counterparty_address, total_value, due_date, status, created_at)
    VALUES (@id, @userId, @counterpartyName, @counterpartyAddress, @totalValue, @dueDate, @status, @createdAt)
  `),
  findById:   db.prepare('SELECT * FROM trades WHERE id = ?'),
  findAll:    db.prepare('SELECT * FROM trades ORDER BY created_at DESC'),
  findByUser: db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC'),
  update:     db.prepare(`
    UPDATE trades
    SET status = @status, reconciliation = @reconciliation, escrow = @escrow, settlement = @settlement, nft = @nft
    WHERE id = @id
  `),
}

// ─── XUMM payload statements ──────────────────────────────────────────────────
const xummStmts = {
  insert:   db.prepare('INSERT INTO xumm_payloads (uuid, trade_id, action, user_id, created_at) VALUES (@uuid, @tradeId, @action, @userId, @createdAt)'),
  findById: db.prepare('SELECT * FROM xumm_payloads WHERE uuid = ?'),
  resolve:  db.prepare('UPDATE xumm_payloads SET resolved = 1, txid = ? WHERE uuid = ?'),
}

function rowToTrade(row) {
  if (!row) return null
  return {
    id:                  row.id,
    userId:              row.user_id,
    counterpartyName:    row.counterparty_name,
    counterpartyAddress: row.counterparty_address,
    totalValue:          row.total_value,
    dueDate:             row.due_date,
    status:              row.status,
    createdAt:           row.created_at,
    reconciliation:      row.reconciliation ? JSON.parse(row.reconciliation) : null,
    escrow:              row.escrow         ? JSON.parse(row.escrow)         : null,
    settlement:          row.settlement     ? JSON.parse(row.settlement)     : null,
    nft:                 row.nft            ? JSON.parse(row.nft)            : null,
  }
}

function rowToUser(row) {
  if (!row) return null
  return { id: row.id, email: row.email, xrplAddress: row.xrpl_address, kycStatus: row.kyc_status || 'pending', createdAt: row.created_at }
}

module.exports = {
  // ── Users ──────────────────────────────────────────────────────────────────
  createUser({ id, email, passwordHash }) {
    userStmts.insert.run({ id, email, passwordHash, createdAt: new Date().toISOString() })
    return rowToUser(userStmts.findById.get(id))
  },

  getUserByEmail(email) {
    const row = userStmts.findByEmail.get(email)
    if (!row) return null
    return { ...rowToUser(row), passwordHash: row.password_hash }
  },

  getUserById(id) {
    return rowToUser(userStmts.findById.get(id))
  },

  setWalletAddress(userId, xrplAddress) {
    userStmts.updateWallet.run(xrplAddress, userId)
    return rowToUser(userStmts.findById.get(userId))
  },

  // ── Trades ─────────────────────────────────────────────────────────────────
  createTrade(trade) {
    tradeStmts.insert.run({ ...trade, status: 'active' })
    return rowToTrade(tradeStmts.findById.get(trade.id))
  },

  getTradeById(id) {
    return rowToTrade(tradeStmts.findById.get(id))
  },

  getAllTrades() {
    return tradeStmts.findAll.all().map(rowToTrade)
  },

  getTradesByUser(userId) {
    return tradeStmts.findByUser.all(userId).map(rowToTrade)
  },

  updateTrade(id, { status, reconciliation, escrow, settlement, nft }) {
    tradeStmts.update.run({
      id,
      status,
      reconciliation: reconciliation ? JSON.stringify(reconciliation) : null,
      escrow:         escrow         ? JSON.stringify(escrow)         : null,
      settlement:     settlement     ? JSON.stringify(settlement)     : null,
      nft:            nft            ? JSON.stringify(nft)            : null,
    })
    return rowToTrade(tradeStmts.findById.get(id))
  },

  // ── XUMM payloads ──────────────────────────────────────────────────────────
  saveXummPayload({ uuid, tradeId, action, userId }) {
    xummStmts.insert.run({ uuid, tradeId: tradeId || null, action, userId: userId || null, createdAt: new Date().toISOString() })
  },

  getXummPayload(uuid) {
    return xummStmts.findById.get(uuid) || null
  },

  resolveXummPayload(uuid, txid) {
    xummStmts.resolve.run(txid, uuid)
  },

  // ── Trades — counterparty access ───────────────────────────────────────────
  getTradesByUserOrCounterparty(userId) {
    return db.prepare(`
      SELECT * FROM trades WHERE user_id = ? OR counterparty_user_id = ? ORDER BY created_at DESC
    `).all(userId, userId).map(rowToTrade)
  },

  setCounterparty(tradeId, counterpartyUserId) {
    db.prepare('UPDATE trades SET counterparty_user_id = ? WHERE id = ?').run(counterpartyUserId, tradeId)
  },

  // ── Invites ────────────────────────────────────────────────────────────────
  createInvite({ token, tradeId, inviteeEmail, invitedBy }) {
    db.prepare('INSERT INTO invites (token, trade_id, invitee_email, invited_by, created_at) VALUES (?,?,?,?,?)')
      .run(token, tradeId, inviteeEmail || null, invitedBy, new Date().toISOString())
    return this.getInvite(token)
  },

  getInvite(token) {
    return db.prepare('SELECT * FROM invites WHERE token = ?').get(token) || null
  },

  acceptInvite(token) {
    db.prepare('UPDATE invites SET accepted_at = ? WHERE token = ?').run(new Date().toISOString(), token)
  },

  // ── Documents ──────────────────────────────────────────────────────────────
  addDocument({ id, tradeId, userId, filename, hash, sizeBytes }) {
    db.prepare('INSERT INTO documents (id, trade_id, user_id, filename, hash, size_bytes, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, tradeId, userId, filename || null, hash, sizeBytes || 0, new Date().toISOString())
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
  },

  getDocuments(tradeId) {
    return db.prepare('SELECT * FROM documents WHERE trade_id = ? ORDER BY created_at DESC').all(tradeId)
  },

  // ── Audit log ──────────────────────────────────────────────────────────────
  logAudit({ tradeId, userId, action, detail, txid }) {
    const id = crypto.randomUUID()
    db.prepare('INSERT INTO audit_log (id, trade_id, user_id, action, detail, txid, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, tradeId, userId || null, action, detail || null, txid || null, new Date().toISOString())
  },

  getAuditLog(tradeId) {
    return db.prepare('SELECT * FROM audit_log WHERE trade_id = ? ORDER BY created_at ASC').all(tradeId)
  },

  // ── KYC ───────────────────────────────────────────────────────────────────
  setKycStatus(userId, status) {
    db.prepare('UPDATE users SET kyc_status = ? WHERE id = ?').run(status, userId)
  },

  close() {
    db.close()
  }
}
