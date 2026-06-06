/**
 * API Integration Tests
 *
 * Run with:  node tests/api.test.js
 * Or via:    npm test  (runs both test files)
 *
 * Uses supertest to exercise HTTP routes against an in-memory SQLite DB.
 * No live XRPL or XUMM connections are made — only auth and trade CRUD routes
 * are covered here (signing routes require wallet integration testing).
 */

'use strict'

// Set env vars BEFORE requiring app so auth.js and db.js pick them up
process.env.JWT_SECRET = 'api-test-secret-32-chars-minimum!!'
process.env.DB_PATH    = ':memory:'

const assert   = require('assert')
const request  = require('supertest')
const app      = require('../src/app')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
    passed++
  } catch (err) {
    console.log(`  FAIL  ${name}`)
    console.log(`        ${err.message}`)
    failed++
  }
}

;(async () => {

let authToken = ''
let tradeId   = ''

// ── Health ────────────────────────────────────────────────────────────────────
console.log('\nHealth')

await test('GET /health returns 200 with status ok', async () => {
  const res = await request(app).get('/health')
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.status, 'ok')
  assert.ok('network' in res.body)
  assert.ok('uptime' in res.body)
})

// ── Auth — register ───────────────────────────────────────────────────────────
console.log('\nAuth — register')

await test('POST /auth/register rejects missing fields', async () => {
  const res = await request(app).post('/auth/register').send({ email: 'a@b.com' })
  assert.strictEqual(res.status, 400)
})

await test('POST /auth/register rejects short password', async () => {
  const res = await request(app).post('/auth/register').send({ email: 'a@b.com', password: 'short' })
  assert.strictEqual(res.status, 400)
  assert.ok(res.body.error.includes('8 characters'))
})

await test('POST /auth/register rejects invalid email', async () => {
  const res = await request(app).post('/auth/register').send({ email: 'not-an-email', password: 'password123' })
  assert.strictEqual(res.status, 400)
  assert.ok(res.body.error.includes('invalid email'))
})

await test('POST /auth/register creates user and returns token', async () => {
  const res = await request(app).post('/auth/register').send({ email: 'alice@test.com', password: 'password123' })
  assert.strictEqual(res.status, 201)
  assert.ok(res.body.token)
  assert.strictEqual(res.body.user.email, 'alice@test.com')
  assert.strictEqual(res.body.user.kycStatus, 'pending')
  authToken = res.body.token
})

await test('POST /auth/register rejects duplicate email', async () => {
  const res = await request(app).post('/auth/register').send({ email: 'alice@test.com', password: 'password123' })
  assert.strictEqual(res.status, 409)
})

// ── Auth — login ──────────────────────────────────────────────────────────────
console.log('\nAuth — login')

await test('POST /auth/login rejects wrong password', async () => {
  const res = await request(app).post('/auth/login').send({ email: 'alice@test.com', password: 'wrongpassword' })
  assert.strictEqual(res.status, 401)
})

await test('POST /auth/login rejects unknown email', async () => {
  const res = await request(app).post('/auth/login').send({ email: 'nobody@test.com', password: 'password123' })
  assert.strictEqual(res.status, 401)
})

await test('POST /auth/login succeeds with correct credentials', async () => {
  const res = await request(app).post('/auth/login').send({ email: 'alice@test.com', password: 'password123' })
  assert.strictEqual(res.status, 200)
  assert.ok(res.body.token)
  assert.strictEqual(res.body.user.email, 'alice@test.com')
})

// ── Auth — me ─────────────────────────────────────────────────────────────────
console.log('\nAuth — me')

await test('GET /auth/me returns 401 without token', async () => {
  const res = await request(app).get('/auth/me')
  assert.strictEqual(res.status, 401)
})

await test('GET /auth/me returns 401 with bad token', async () => {
  const res = await request(app).get('/auth/me').set('Authorization', 'Bearer not-a-token')
  assert.strictEqual(res.status, 401)
})

await test('GET /auth/me returns user with valid token', async () => {
  const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${authToken}`)
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.user.email, 'alice@test.com')
})

// ── Auth — wallet ─────────────────────────────────────────────────────────────
console.log('\nAuth — wallet')

await test('POST /auth/wallet rejects invalid XRPL address', async () => {
  const res = await request(app)
    .post('/auth/wallet')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ xrplAddress: 'not-an-address' })
  assert.strictEqual(res.status, 400)
})

await test('POST /auth/wallet links a valid XRPL address', async () => {
  const res = await request(app)
    .post('/auth/wallet')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ xrplAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' })
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.user.xrplAddress, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')
})

// ── Trades ────────────────────────────────────────────────────────────────────
console.log('\nTrades')

await test('POST /trade returns 401 without token', async () => {
  const res = await request(app).post('/trade').send({})
  assert.strictEqual(res.status, 401)
})

await test('POST /trade rejects missing fields', async () => {
  const res = await request(app)
    .post('/trade')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ counterpartyName: 'Bob' })
  assert.strictEqual(res.status, 400)
})

await test('POST /trade rejects invalid counterpartyAddress', async () => {
  const res = await request(app)
    .post('/trade')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ counterpartyName: 'Bob', counterpartyAddress: 'bad-address', totalValue: 5000, dueDate: '2026-12-31' })
  assert.strictEqual(res.status, 400)
  assert.ok(res.body.error.includes('valid XRPL address'))
})

await test('POST /trade rejects non-positive totalValue', async () => {
  const res = await request(app)
    .post('/trade')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ counterpartyName: 'Bob', counterpartyAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', totalValue: -100, dueDate: '2026-12-31' })
  assert.strictEqual(res.status, 400)
})

await test('POST /trade creates a trade with TF- prefix', async () => {
  const res = await request(app)
    .post('/trade')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ counterpartyName: 'Bob Corp', counterpartyAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', totalValue: 5000, dueDate: '2026-12-31' })
  assert.strictEqual(res.status, 201)
  assert.ok(res.body.trade.id.startsWith('TF-'))
  assert.strictEqual(res.body.trade.status, 'active')
  assert.strictEqual(res.body.trade.totalValue, 5000)
  tradeId = res.body.trade.id
})

// ── Trade list with pagination ────────────────────────────────────────────────
console.log('\nTrades — pagination')

await test('GET /trades returns trades with pagination metadata', async () => {
  const res = await request(app)
    .get('/trades')
    .set('Authorization', `Bearer ${authToken}`)
  assert.strictEqual(res.status, 200)
  assert.ok(Array.isArray(res.body.trades))
  assert.strictEqual(typeof res.body.total, 'number')
  assert.strictEqual(typeof res.body.limit, 'number')
  assert.strictEqual(typeof res.body.offset, 'number')
  assert.ok(res.body.trades.length >= 1)
})

await test('GET /trades respects ?limit query param', async () => {
  const res = await request(app)
    .get('/trades?limit=1&offset=0')
    .set('Authorization', `Bearer ${authToken}`)
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.limit, 1)
  assert.ok(res.body.trades.length <= 1)
})

await test('GET /trades caps limit at 100', async () => {
  const res = await request(app)
    .get('/trades?limit=9999')
    .set('Authorization', `Bearer ${authToken}`)
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.limit, 100)
})

// ── Trade access control ──────────────────────────────────────────────────────
console.log('\nTrade access control')

await test('GET /trade/:id/audit returns 403 for non-participant', async () => {
  // Register a second user who has no relation to the trade
  const reg = await request(app).post('/auth/register').send({ email: 'bob@test.com', password: 'password123' })
  const bobToken = reg.body.token

  const res = await request(app)
    .get(`/trade/${tradeId}/audit`)
    .set('Authorization', `Bearer ${bobToken}`)
  assert.strictEqual(res.status, 403)
})

await test('GET /trade/:id/audit returns log for trade owner', async () => {
  const res = await request(app)
    .get(`/trade/${tradeId}/audit`)
    .set('Authorization', `Bearer ${authToken}`)
  assert.strictEqual(res.status, 200)
  assert.ok(Array.isArray(res.body.log))
})

// ── Reconciliation validation ─────────────────────────────────────────────────
console.log('\nReconciliation validation (N-3/N-4)')

await test('POST /trade/:id/sign-reconcile rejects missing yourShare', async () => {
  const res = await request(app)
    .post(`/trade/${tradeId}/sign-reconcile`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({})
  assert.strictEqual(res.status, 400)
  assert.ok(res.body.error.includes('yourShare'))
})

await test('POST /trade/:id/sign-reconcile rejects negative yourShare', async () => {
  const res = await request(app)
    .post(`/trade/${tradeId}/sign-reconcile`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ yourShare: -100 })
  assert.strictEqual(res.status, 400)
  assert.ok(res.body.error.includes('positive'))
})

await test('POST /trade/:id/sign-reconcile rejects yourShare > totalValue', async () => {
  const res = await request(app)
    .post(`/trade/${tradeId}/sign-reconcile`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ yourShare: 99999 })
  assert.strictEqual(res.status, 400)
  assert.ok(res.body.error.includes('cannot exceed'))
})

// ── KYC ──────────────────────────────────────────────────────────────────────
console.log('\nKYC')

await test('GET /kyc/status returns pending for new user', async () => {
  const res = await request(app)
    .get('/kyc/status')
    .set('Authorization', `Bearer ${authToken}`)
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.body.kycStatus, 'pending')
})

await test('POST /kyc/webhook rejects invalid status value', async () => {
  const meRes = await request(app).get('/auth/me').set('Authorization', `Bearer ${authToken}`)
  const userId = meRes.body.user.id
  const res = await request(app)
    .post('/kyc/webhook')
    .send({ userId, status: 'unknown' })
  assert.strictEqual(res.status, 400)
})

await test('POST /kyc/webhook updates KYC status to verified', async () => {
  const meRes = await request(app).get('/auth/me').set('Authorization', `Bearer ${authToken}`)
  const userId = meRes.body.user.id

  const webhookRes = await request(app)
    .post('/kyc/webhook')
    .send({ userId, status: 'verified' })
  assert.strictEqual(webhookRes.status, 200)

  const kycRes = await request(app)
    .get('/kyc/status')
    .set('Authorization', `Bearer ${authToken}`)
  assert.strictEqual(kycRes.body.kycStatus, 'verified')
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`)
console.log(`  ${passed} passed, ${failed} failed`)
console.log(`${'─'.repeat(40)}\n`)

// Cleanup
await app.shutdown()

if (failed > 0) process.exit(1)

})() // end async IIFE
