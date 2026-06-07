'use strict'

const db = require('./db')

const TRAVEL_RULE_THRESHOLD = parseFloat(process.env.TRAVEL_RULE_THRESHOLD || '1000')

function checkTravelRule(amountUsd, kycStatus) {
  if (amountUsd > TRAVEL_RULE_THRESHOLD && kycStatus !== 'verified') {
    return {
      blocked: true,
      reason: `KYC verification required for transactions above $${TRAVEL_RULE_THRESHOLD.toLocaleString()} USD`,
    }
  }
  return { blocked: false }
}

// Write to stdout (for log aggregators) and persist to aml_log table
function amlLog({ userId, tradeId, amountUsd, action, ledgerTxid }) {
  const flag = amountUsd > TRAVEL_RULE_THRESHOLD ? 'TRAVEL_RULE_REVIEW' : null
  const entry = {
    ts: new Date().toISOString(),
    userId,
    tradeId: tradeId || null,
    amountUsd,
    action,
    flag,
  }
  console.log(`[AML] ${JSON.stringify(entry)}`)
  db.logAml({ userId, tradeId, amountUsd, action, flag, ledgerTxid }).catch(err => console.error('[AML] db write failed:', err.message))
}

module.exports = { checkTravelRule, amlLog, TRAVEL_RULE_THRESHOLD }
