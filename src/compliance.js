'use strict'

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

// Structured AML log — swap console.log for a SIEM/compliance aggregator in production
function amlLog({ userId, tradeId, amountUsd, action }) {
  const entry = {
    ts:      new Date().toISOString(),
    userId,
    tradeId: tradeId || null,
    amountUsd,
    action,
    flag:    amountUsd > TRAVEL_RULE_THRESHOLD ? 'TRAVEL_RULE_REVIEW' : null,
  }
  console.log(`[AML] ${JSON.stringify(entry)}`)
}

module.exports = { checkTravelRule, amlLog, TRAVEL_RULE_THRESHOLD }
