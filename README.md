# TradeFlow Ledger — RWA-Enabled Trade Reconciliation & RLUSD Settlement on XRPL

TradeFlow Ledger is an open-source Proof of Concept for a trade finance platform that
automates expense reconciliation and enables instant RLUSD settlements on the XRP Ledger,
with RWA tokenization of reconciled invoices for financing.

---

## Problem Statement

Traditional trade reconciliation is manual and slow:

- Shared costs (freight, insurance, customs) lead to disputes and delays
- Spreadsheets and emails cause opacity and errors
- Settlements take 30–90 days with high fees and FX risk
- $1.5T global SME financing gap from illiquid unpaid invoices

TradeFlow automates reconciliation, provides on-chain transparency, and unlocks instant
RLUSD settlements — with MPT-based RWA tokenization for early cash flow.

---

## Security Notes

- **Testnet only** — never connect a mainnet wallet to this PoC
- **Never commit real seeds** — `.env` is in `.gitignore`; use `.env.example` as a template
- **Production signing** — for mainnet use, replace seed-based signing with a hardware wallet or [XUMM SDK](https://xumm.readme.io/) so private keys never touch the server
- **No auth on API** — the REST endpoints have no authentication; add API keys or JWT before any public deployment

---

## XRPL Testnet Demo

The full trade lifecycle runs end-to-end on XRPL Testnet today.

```
node scripts/testnet-demo.js
```

**What the demo executes:**

| Step | Transaction | XRPL Type |
|------|-------------|-----------|
| 1 | Fund two wallets (exporter + importer) | Faucet |
| 2 | Set RLUSD trust lines | `TrustSet` |
| 3 | Trade deposit with TradeFlow memo | `Payment` + Memo |
| 4 | Immutable reconciliation record | `Payment` (1 drop) + Memo |
| 5 | Conditional settlement lock | `EscrowCreate` |
| 6 | Settlement release after time lock | `EscrowFinish` |
| 7 | Tokenize reconciled invoice as RWA | `NFTokenMint` (altnet) → `MPTokenIssuanceCreate` (mainnet) |

**Live run output** (March 23 2026 — all 7 transactions confirmed on XRPL Testnet):

```
Exporter wallet : https://testnet.xrpl.org/accounts/rG5dsQoWEHf5spuFacJVDPyvx6k3GRy1fQ
Importer wallet : https://testnet.xrpl.org/accounts/r3QTtak5E29tT7J9YmyAzoM424ivpkdJvM

Transactions
├─ Exporter TrustSet   → https://testnet.xrpl.org/transactions/EDB6D650739DC24BF9E5113B80C63E04C087F9AA3149A428FEE74283B615C0C4
├─ Importer TrustSet   → https://testnet.xrpl.org/transactions/6029014486ECA2743EF6AD680DA8CC98B49EC49548B10F0F032E00BBFFB436B2
├─ XRP Payment         → https://testnet.xrpl.org/transactions/3AE04A820B2CEB23D240BF0EDB87744FC47E2EB46ED71B8D45F0CCCC3698D69F
├─ Reconciliation      → https://testnet.xrpl.org/transactions/1A5107ED70C54992D7EAAD3BCB4186358EF72E35EF6AA8159775FBE773590AF0
├─ EscrowCreate        → https://testnet.xrpl.org/transactions/CD2664AC82737694C9B1547E1F5787BA9C6546F7FDAC2F87D9E1C01E6F92E1E9
├─ EscrowFinish        → https://testnet.xrpl.org/transactions/199C26EF2F6A4E66F85A37094D8B89972AB4A47226C3D828A80C32BAE37B5C0B
└─ NFT Tokenisation    → https://testnet.xrpl.org/transactions/D7CFACF93B29259290DE637A8AC2E0C2E72B6A871E945842726CEC58DD98CBBD

Trade ID   : TF-1774225343875
Invoice ID : INV-19D1812625C
```

**Settlement payment code** (`src/xrplClient.js`):

```js
const tx = {
  TransactionType: "Payment",
  Account: wallet.classicAddress,
  Destination: toAddress,
  Amount: {
    currency: "524C555344000000000000000000000000000000", // RLUSD hex
    issuer: RLUSD_ISSUER,
    value: String(amount)
  },
  Memos: [{
    Memo: {
      MemoType: Buffer.from("TradeFlow/TradeID").toString("hex").toUpperCase(),
      MemoData: Buffer.from(tradeId).toString("hex").toUpperCase()
    }
  }]
}

const prepared = await client.autofill(tx)
const signed   = wallet.sign(prepared)
const result   = await client.submitAndWait(signed.tx_blob)
// → result.result.hash  (immutable on-chain record)
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- A free XRPL Testnet wallet — [faucet.altnet.rippletest.net](https://faucet.altnet.rippletest.net/accounts)

### Install

```bash
git clone https://github.com/Cypher928/Type-tradeflow-poc.git
cd Type-tradeflow-poc
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
XRPL_NODE=wss://s.altnet.rippletest.net:51233
XRPL_WALLET_SEED=your_testnet_seed_here        # never use a mainnet seed
XRPL_DESTINATION_ADDRESS=your_testnet_address
RLUSD_ISSUER=rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV
PORT=3000
```

### Run

```bash
npm start          # production
npm run dev        # nodemon watch mode
```

Server starts at `http://localhost:3000`.
Open `http://localhost:3000` in your browser for the demo UI.

### API quick test

```bash
# Health check
curl http://localhost:3000/health

# Create a trade
curl -X POST http://localhost:3000/trade \
  -H "Content-Type: application/json" \
  -d '{"counterpartyName":"Acme Imports","counterpartyAddress":"rXXX...","totalValue":5000,"dueDate":"2026-06-30"}'

# List trades
curl http://localhost:3000/trades
```

### Run tests

```bash
npm test           # unit tests — no live network required
```

### Run full testnet demo

```bash
npm run demo       # funds wallets, runs all 7 XRPL transactions, prints explorer URLs
```

---

## Frontend UI

`public/index.html` is a lightweight single-page dashboard served at `http://localhost:3000` when the server is running. No build step required — pure HTML/CSS/JS.

**What it includes:**

| Section | Description |
|---------|-------------|
| Pipeline overview | Visual 5-step flow (Create → Reconcile → Escrow → Settle → Tokenise) |
| Create Trade form | POST to `/trade` with counterparty name, XRPL address, value, due date |
| Quick Settlement | Send XRP or RLUSD via `/settle`, returns hash + explorer link |
| Active Trades list | Live-refreshable list of all trades with status badges |
| Node Status | `/health` check showing XRPL connection and network |

The UI uses a dark GitHub-style theme and requires the server to be running on port 3000.

**UI layout (dark theme, runs at `http://localhost:3000`):**

```
┌─────────────────────────────────────────────────────────────────┐
│ ◈ TradeFlow Ledger  [Testnet]                                   │
├─────────────────────────────────────────────────────────────────┤
│          Trade Finance on the XRP Ledger                        │
│  Create → Reconcile → Escrow → Settle → Tokenise                │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐             │
│  │  01  │  │  02  │  │  03  │  │  04  │  │  05  │             │
│  │Create│  │Reconc│  │Escrow│  │Settle│  │Tokenise│            │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘             │
├─────────────────────────────────────────────────────────────────┤
│ Create New Trade                                                │
│  Counterparty Name ________  XRPL Address ___________________  │
│  Total Value (USD) ________  Due Date ______  [Create Trade]   │
├─────────────────────────────────────────────────────────────────┤
│ Quick Settlement                                                │
│  Amount ________  Currency [XRP ▾]  [Send Payment]             │
│  → On success: tx hash + testnet.xrpl.org explorer link        │
├─────────────────────────────────────────────────────────────────┤
│ Active Trades                                          [Refresh]│
│  TF-1234567  Acme Imports · $5,000 · Due 2026-06-30  [active] │
│  TF-9876543  Beta Corp   · $1,200 · Due 2026-05-15  [settled] │
├─────────────────────────────────────────────────────────────────┤
│ Node Status                         [Check /health]             │
│  Status: ok · Network: testnet · 2026-03-23T00:00:00Z          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
TradeFlow PoC
├── src/
│   ├── server.js        — Express API (trade, reconcile, settle endpoints)
│   └── xrplClient.js    — XRPL functions: payments, escrow, MPT, trust lines
├── scripts/
│   └── testnet-demo.js  — End-to-end 7-step testnet walkthrough
├── tests/
│   └── xrplClient.test.js — Unit tests (no network)
├── contracts/
│   ├── TradeFlowEscrow.sol — Solidity escrow for XRPL EVM Sidechain
│   └── README.md           — XRPL transaction patterns + EVM deploy guide
└── public/
    └── index.html       — Browser demo UI
```

### XRPL features implemented

| Feature | Status | Transaction Type |
|---------|--------|-----------------|
| XRP payment with trade memo | Done | `Payment` |
| RLUSD stablecoin settlement | Done | `Payment` (IOU) |
| RLUSD trust line setup | Done | `TrustSet` |
| On-chain reconciliation record | Done | `Payment` + Memo |
| Conditional escrow | Done | `EscrowCreate` / `EscrowFinish` |
| Invoice tokenization as RWA | Done | `NFTokenMint` (altnet) / `MPTokenIssuanceCreate` (mainnet) |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Node + network status |
| `POST` | `/trade` | Create new trade |
| `GET` | `/trades` | List all trades |
| `POST` | `/trade/:id/reconcile` | Record reconciliation on-chain |
| `POST` | `/trade/:id/settle` | Settle trade with RLUSD |
| `POST` | `/settle` | Direct payment (XRP or RLUSD) |

---

## Purpose & Grant Alignment

This PoC aligns with XRPL Grants priorities:

- **Trade finance** — reconciliation and settlement for importers/exporters
- **Payments** — RLUSD instant settlement vs 30–90 day wire transfers
- **Stablecoins** — RLUSD as the settlement currency
- **Real-World Assets** — MPT-based invoice tokenization for working capital
- **On-chain activity** — every trade step writes to the ledger

---

## Validation & Early Traction

- Concept validated with 15+ trade professionals (exporters, importers, logistics)
- Consistent feedback: strong demand for faster reconciliation and instant settlement
- Early conversations with small trade partners for pilot testing
- Prototype & architecture: [Miro board](https://miro.com/app/board/uXjVGaMTsgY=/)
- Technical assets: [Google Drive](https://drive.google.com/drive/mobile/folders/1UjXPqyrzOXoQoVGjBjxpbX1qGEXzc1FW)

---

## Grant Milestones (12 Months)

| Quarter | Milestone |
|---------|-----------|
| Q1 2026 | RLUSD settlements + MPT tokenization live on testnet ✓ |
| Q2 2026 | Beta with 20 trade partners — 100+ monthly on-chain transactions |
| Q3 2026 | EVM sidechain integration — `TradeFlowEscrow.sol` stub ready; full deploy to XRPL EVM Devnet |
| Q4 2026 | 200+ users, $1M+ settled volume run-rate |

---

## Open Source

MIT licensed. Fully open-source to serve as a foundation for the XRPL trade finance
ecosystem. Future contributions: reusable reconciliation library, EVM contract templates.

See [CONTRIBUTING.md](CONTRIBUTING.md) to get involved.

---

## About

**Lynn Raymond** — Founder with years of experience in expense reconciliation and shared
cost disputes in commercial environments.

Built for the XRPL ecosystem. Focused on real-world financial utility.
