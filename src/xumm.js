'use strict'

// XUMM (Xaman) sign-request integration.
// Requires XUMM_API_KEY and XUMM_API_SECRET in .env.
// Get credentials at https://apps.xumm.dev

const { Xumm } = require('xumm')

let _xumm = null

function getClient() {
  if (!_xumm) {
    const key    = process.env.XUMM_API_KEY
    const secret = process.env.XUMM_API_SECRET
    if (!key || !secret) {
      throw new Error('XUMM_API_KEY and XUMM_API_SECRET must be set in .env to use wallet signing')
    }
    _xumm = new Xumm(key, secret)
  }
  return _xumm
}

// Create a sign request for a transaction.
// Returns { uuid, qr_png, deep_link, websocket_status } for the frontend to display.
async function createPayload(txJson, { returnUrl, userToken } = {}) {
  const xumm = getClient()

  const payload = {
    txjson: txJson,
    options: { submit: true, return_url: { app: returnUrl, web: returnUrl } },
  }
  if (userToken) payload.user_token = userToken

  const result = await xumm.payload.create(payload)
  return {
    uuid:      result.uuid,
    qr_png:    result.refs.qr_png,
    deep_link: result.next.always,
    ws_url:    result.refs.websocket_status,
  }
}

// Poll a payload by UUID. Returns:
//   { signed: false }                          — still waiting
//   { signed: true, txid, userToken }          — approved and submitted
//   { signed: false, cancelled: true }         — user rejected
async function getPayloadStatus(uuid) {
  const xumm   = getClient()
  const result = await xumm.payload.get(uuid)

  if (!result.meta.resolved) return { signed: false }
  if (!result.meta.signed)   return { signed: false, cancelled: true }

  return {
    signed:    true,
    txid:      result.response.txid,
    account:   result.response.account,
    userToken: result.application.issued_user_token || null,
  }
}

module.exports = { createPayload, getPayloadStatus }
