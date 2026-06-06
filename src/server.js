'use strict'

require('dotenv').config()

// ─── Required environment guard ───────────────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET']
const missingEnv   = REQUIRED_ENV.filter(k => !process.env[k])
if (missingEnv.length) {
  console.error(`[startup] Missing required environment variables: ${missingEnv.join(', ')}`)
  console.error('[startup] Copy .env.example to .env and fill in the values.')
  process.exit(1)
}

const app  = require('./app')
const port = process.env.PORT || 3000

const server = app.listen(port, () => console.log(`TradeFlow server running on port ${port}`))

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log('\nShutting down…')
  await app.shutdown()
  server.close()
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)
