'use strict'

const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')

const JWT_SECRET  = process.env.JWT_SECRET  || 'change-me-in-production'
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d'

if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'change-me-in-production') {
  throw new Error('JWT_SECRET must be set in production')
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

function decodeToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

// Express middleware — attaches req.userId or returns 401
function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    const payload = decodeToken(header.slice(7))
    req.userId = payload.sub
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

module.exports = { hashPassword, verifyPassword, signToken, requireAuth }
