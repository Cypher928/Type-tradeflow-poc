'use strict'

const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/tradeflow.db')

// Ensure data directory exists
const fs = require('fs')
const dataDir = path.dirname(DB_PATH)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const db = new Database(DB_PATH)

db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id                  TEXT PRIMARY KEY,
    counterparty_name   TEXT NOT NULL,
    counterparty_address TEXT NOT NULL,
    total_value         REAL NOT NULL,
    due_date            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TEXT NOT NULL,
    reconciliation      TEXT,
    settlement          TEXT
  )
`)

const stmts = {
  insert: db.prepare(`
    INSERT INTO trades (id, counterparty_name, counterparty_address, total_value, due_date, status, created_at)
    VALUES (@id, @counterpartyName, @counterpartyAddress, @totalValue, @dueDate, @status, @createdAt)
  `),
  findById: db.prepare('SELECT * FROM trades WHERE id = ?'),
  findAll:  db.prepare('SELECT * FROM trades ORDER BY created_at DESC'),
  update:   db.prepare(`
    UPDATE trades SET status = @status, reconciliation = @reconciliation, settlement = @settlement
    WHERE id = @id
  `)
}

function rowToTrade(row) {
  if (!row) return null
  return {
    id:                  row.id,
    counterpartyName:    row.counterparty_name,
    counterpartyAddress: row.counterparty_address,
    totalValue:          row.total_value,
    dueDate:             row.due_date,
    status:              row.status,
    createdAt:           row.created_at,
    reconciliation:      row.reconciliation ? JSON.parse(row.reconciliation) : null,
    settlement:          row.settlement     ? JSON.parse(row.settlement)     : null,
  }
}

module.exports = {
  createTrade(trade) {
    stmts.insert.run({ ...trade, status: 'active', createdAt: trade.createdAt })
    return this.getById(trade.id)
  },

  getById(id) {
    return rowToTrade(stmts.findById.get(id))
  },

  getAll() {
    return stmts.findAll.all().map(rowToTrade)
  },

  updateTrade(id, { status, reconciliation, settlement }) {
    stmts.update.run({
      id,
      status,
      reconciliation: reconciliation ? JSON.stringify(reconciliation) : null,
      settlement:     settlement     ? JSON.stringify(settlement)     : null,
    })
    return this.getById(id)
  },

  close() {
    db.close()
  }
}
