# CLAUDE.md - TradeFlow Ledger PoC

AI assistant guide for the `type-tradeflow-poc` repository.

## Project Overview

TradeFlow Ledger is a trade finance settlement Proof of Concept built on the XRP Ledger (XRPL). It demonstrates on-chain reconciliation, RLUSD stablecoin settlement, time-locked escrow, and RWA tokenization of invoices — all on the XRPL Testnet.

**Stack:** Node.js (>=18), Express.js, XRPL JS SDK v3, vanilla HTML/CSS/JS frontend, Solidity (EVM Sidechain)

---

## Repository Structure

```
Type-tradeflow-poc/
├── src/
│   ├── server.js          # Express REST API + static file server (main entry)
│   └── xrplClient.js      # XRPL integration: payments, escrow, memos, MPT/NFT
├── scripts/
│   ├── testnet-demo.js    # 7-step end-to-end testnet walkthrough
│   ├── compile-evm.js     # Compile TradeFlowEscrow.sol via solc
│   ├── deploy-evm-run.js  # Deploy contract to XRPL EVM Sidechain (CommonJS)
│   └── deploy-evm.mjs     # Deploy contract to XRPL EVM Sidechain (ESM)
├── contracts/
│   ├── TradeFlowEscrow.sol  # Solidity escrow for XRPL EVM Sidechain
│   ├── TradeFlowEscrow.json # Compiled ABI + bytecode artifact
│   └── README.md           # Contract docs and memo schema specs
├── tests/
│   └── xrplClient.test.js  # Unit tests (no network, pure assertions)
├── public/
│   └── index.html          # Single-page dashboard (vanilla JS/CSS)
├── docs/
│   ├── dashboard.png
│   ├── demo-output.png
│   └── demo-output.txt     # Successful testnet run with tx hashes
├── .env.example            # Environment variable template
├── package.json
├── README.md
└── CONTRIBUTING.md
```

---

## Environment Setup

Copy `.env.example` to `.env` and fill in values:

```bash
XRPL_NODE=wss://s.altnet.rippletest.net:51233
XRPL_WALLET_SEED=your_testnet_seed_here
XRPL_DESTINATION_ADDRESS=your_testnet_address_here
RLUSD_ISSUER=rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV
PORT=3000
```

**NEVER commit `.env` or any wallet seed.** The `.gitignore` excludes `.env` files. For EVM scripts, `EVM_PRIVATE_KEY` is a separate env var.

---

## Development Commands

```bash
npm start          # Start server (node src/server.js)
npm run dev        # Start with nodemon (auto-reload on changes)
npm test           # Run unit tests (node tests/xrplClient.test.js)
npm run demo       # Run 7-step end-to-end testnet demo
npm run compile:evm  # Compile TradeFlowEscrow.sol → contracts/TradeFlowEscrow.json
npm run deploy:evm   # Deploy to XRPL EVM Sidechain Devnet
```

---

## Architecture

### API Server (`src/server.js`)

Single Express.js server that:
- Maintains one persistent XRPL WebSocket connection
- Stores trades in an **in-memory `Map`** (resets on restart — no database)
- Serves the SPA from `public/index.html` for all unmatched GET routes

**API Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server/network status |
| POST | `/trade` | Create a new trade |
| GET | `/trades` | List all in-memory trades |
| POST | `/trade/:id/reconcile` | Record reconciliation on-chain |
| POST | `/trade/:id/settle` | Settle trade with RLUSD |
| POST | `/settle` | Direct XRP or RLUSD payment |
| GET | `/*` | Serves `public/index.html` |

**Trade lifecycle states:** `active` → `reconciled` → `settled`

**Trade object shape:**
```js
{
  id: "TF-A1B2C3D4",           // "TF-" + 8 hex chars
  counterpartyName: string,
  counterpartyAddress: string,  // XRPL rAddress
  totalValue: number,           // USD value
  dueDate: string,              // ISO date
  status: "active" | "reconciled" | "settled",
  createdAt: string,            // ISO timestamp
  reconciliation?: {
    yourShare: number,
    onChain: { hash, status, explorerUrl },
    recordedAt: string
  },
  settlement?: {
    amount: string,
    currency: "RLUSD" | "XRP",
    onChain: { hash, status, explorerUrl },
    settledAt: string
  }
}
```

**XRPL transaction response shape:**
```js
{ hash, status, explorerUrl, escrowSequence?, escrowOwner?, metadata? }
```

---

### XRPL Client (`src/xrplClient.js`)

Low-level XRPL utility module. All functions are async and return the transaction response shape above.

**Key functions:**

| Function | Description |
|----------|-------------|
| `fundTestnetWallet()` | Request faucet funds, returns new Wallet |
| `getBalances(address)` | Query XRP balance |
| `sendTestPayment({fromSeed, toAddress, amount, memo})` | XRP payment |
| `sendRLUSDPayment({fromSeed, toAddress, amount, tradeId, invoiceHash})` | RLUSD payment |
| `setRLUSDTrustLine({walletSeed, limit})` | Set TrustSet for RLUSD (default limit 1M) |
| `recordReconciliationOnChain({walletSeed, counterpartyAddress, tradeId, totalCost, yourShare, invoiceHash})` | 1-drop Payment + JSON memo |
| `createEscrow({senderSeed, destination, xrpAmount, releaseAfterSeconds, tradeId})` | Time-locked EscrowCreate |
| `finishEscrow({finisherSeed, escrowOwner, escrowSequence})` | EscrowFinish |
| `tokenizeInvoiceAsMPT({issuerSeed, tradeId, invoiceAmount, dueDate, invoiceHash})` | NFTokenMint (testnet) / MPTokenIssuanceCreate (mainnet) |

**XRPL constants:**
- RLUSD currency hex: `524C555344000000000000000000000000000000`
- RLUSD issuer (testnet): `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`
- Network: `wss://s.altnet.rippletest.net:51233`

**Memo schema (all values hex-encoded UTF-8):**
- `MemoType: "TradeFlow/TradeID"` — trade identifier
- `MemoType: "TradeFlow/Reconciliation"` — JSON: `{tradeId, totalCost, yourShare, invoiceHash}`
- `MemoType: "TradeFlow/InvoiceHash"` — SHA256 hash
- `MemoType: "TradeFlow/InvoiceTokenization"` — trade ID for MPT metadata

---

### Smart Contract (`contracts/TradeFlowEscrow.sol`)

Solidity 0.8.20 contract for the **XRPL EVM Sidechain** (Chain ID `1440002`).

- **`createEscrow(exporter, releaseDelay, refundDelay, tradeId)`** — importer deposits XRP with dual time-locks
- **`release(id)`** — exporter claims funds after `releaseAfter` timestamp
- **`refund(id)`** — importer reclaims after `refundAfter` timestamp
- **`getEscrow(id)`** — view-only inspector

EVM Sidechain Devnet RPC: `https://rpc.evm.devnet.ripple.com`

---

## Testing

Tests live in `tests/xrplClient.test.js`. They use **no test framework** — just Node.js `assert` with a custom pass/fail counter. Run with `npm test` (which calls `node tests/xrplClient.test.js`).

**Coverage:**
- RLUSD hex currency code encoding
- XRP ↔ drops conversions
- Memo type/data encoding round-trips
- Trade ID format validation (`TF-` prefix, 11 chars)
- Reconciliation payload JSON serialization
- Ripple epoch time conversion

Tests exit with code `1` if any assertion fails.

**To add tests:** follow the existing pattern — call a utility, assert the result, increment pass/fail counters.

---

## Code Conventions

- **No TypeScript, no build step.** This is plain CommonJS Node.js (`.js` files, `require()`).
- **One exception:** `deploy-evm.mjs` uses ESM (`import/export`) — do not mix `require()` into it.
- **No linter/formatter configured.** Follow existing code style: 2-space indentation, single quotes.
- **In-memory state only.** Do not add a database dependency to the PoC without explicit intent.
- **Error handling:** Express routes use try/catch and return `{error: message}` with appropriate HTTP status codes (400 for bad input, 404 for missing trade, 500 for XRPL errors).
- **Trade IDs:** Generated as `"TF-" + crypto.randomBytes(4).toString("hex").toUpperCase()` (11 chars total).
- **Explorer URLs:** Always link to `https://testnet.xrpl.org/transactions/{hash}`.

---

## Security Rules

1. **Testnet only** — never use real/mainnet seeds. The `.env.example` uses altnet endpoints.
2. **Never commit secrets** — `.env` is gitignored; seeds, private keys must stay out of source.
3. **No API authentication** — endpoints are unauthenticated (intentional for PoC). Add auth before any public deployment.
4. **No server-side input validation** — add validation before production use.

---

## 7-Step Trade Lifecycle (Demo Flow)

The `scripts/testnet-demo.js` walks through the full flow:

1. Fund two wallets (buyer/seller) via testnet faucet
2. Set RLUSD trust lines on both wallets (`TrustSet`)
3. Send XRP payment with trade memo (`Payment` + `Memos`)
4. Record reconciliation on-chain (1-drop `Payment` + JSON `Memo`)
5. Create time-locked escrow (`EscrowCreate`, 30-second lock for demo)
6. Release escrow after time-lock (`EscrowFinish`)
7. Tokenize invoice as NFT/MPT (`NFTokenMint` on testnet, `MPTokenIssuanceCreate` on mainnet)

All transactions should return `tesSUCCESS`.

---

## What Is Not Implemented (Known Gaps)

- No database — trades are lost on restart
- No API authentication or rate limiting
- No server-side request validation
- EVM Sidechain deployment awaiting Devnet access
- XRPL Hooks integration awaiting amendment activation
- KYC/KYB (Sumsub), FATF Travel Rule, AML monitoring — planned for production
