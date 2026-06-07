'use strict'

// Email notifications via Resend (https://resend.com).
// If RESEND_API_KEY is not set, emails are logged to console only.
// Get a free API key at resend.com — 3,000 emails/month on the free tier.

let _resend = null

function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY
    if (!key) return null
    const { Resend } = require('resend')
    _resend = new Resend(key)
  }
  return _resend
}

const FROM = process.env.EMAIL_FROM || 'TradeFlow <noreply@tradeflow.io>'

async function send({ to, subject, html, text }) {
  const resend = getResend()
  if (!resend) {
    console.log(`[EMAIL — no RESEND_API_KEY] To: ${to} | Subject: ${subject}`)
    return
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html: html || `<p>${text}</p>` })
  } catch (err) {
    console.error(`[EMAIL] Failed to send to ${to}:`, err.message)
  }
}

// ── Notification templates ────────────────────────────────────────────────────

function tradeInvite({ to, inviterEmail, tradeName, tradeValue, inviteUrl }) {
  return send({
    to,
    subject: `${inviterEmail} invited you to a trade on TradeFlow`,
    html: `
      <h2>You've been invited to a trade</h2>
      <p><strong>${inviterEmail}</strong> has invited you to join a trade on TradeFlow Ledger.</p>
      <ul>
        <li>Trade: <strong>${tradeName}</strong></li>
        <li>Value: <strong>$${Number(tradeValue).toLocaleString()} USD</strong></li>
      </ul>
      <p><a href="${inviteUrl}" style="background:#238636;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">View &amp; Accept Trade →</a></p>
      <hr/>
      <p style="color:#8b949e;font-size:12px">TradeFlow Ledger — Trade Finance on the XRP Ledger</p>
    `,
  })
}

function tradeStatusChanged({ to, tradeId, status, explorerUrl }) {
  const labels = { reconciled: 'reconciled', escrowed: 'escrowed', settled: 'settled', tokenised: 'tokenised as RWA' }
  const label = labels[status] || status
  return send({
    to,
    subject: `Trade ${tradeId} has been ${label}`,
    html: `
      <h2>Trade update: ${tradeId}</h2>
      <p>Your trade has been <strong>${label}</strong>.</p>
      ${explorerUrl ? `<p><a href="${explorerUrl}">View on XRPL Explorer →</a></p>` : ''}
      <hr/>
      <p style="color:#8b949e;font-size:12px">TradeFlow Ledger</p>
    `,
  })
}

module.exports = { send, tradeInvite, tradeStatusChanged }
