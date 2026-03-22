# TradeFlow — On-Chain Contracts & Hooks

TradeFlow uses the **XRP Ledger** natively. Instead of EVM-style smart contracts,
business logic is enforced through XRPL's built-in transaction types and,
optionally, **XRPL Hooks** (WebAssembly modules that execute on-chain).

---

## Transaction Patterns Used

| Pattern | XRPL Type | Purpose |
|---|---|---|
| Trade deposit | `Payment` + Memo | Record trade ID on-chain |
| Reconciliation | `Payment` (1 drop) + Memo | Immutable audit trail |
| Conditional settlement | `EscrowCreate` / `EscrowFinish` | Time-locked fund release |
| Invoice tokenisation | `MPTokenIssuanceCreate` | RWA token for trade invoice |
| Stablecoin settlement | `Payment` (RLUSD) | Final net settlement |
| Trust line | `TrustSet` | Authorize RLUSD receipt |

All patterns are implemented in [`src/xrplClient.js`](../src/xrplClient.js).

---

## Memo Schema

TradeFlow stores structured data in XRPL transaction Memos.
Both `MemoType` and `MemoData` are hex-encoded UTF-8 strings.

### Trade ID memo
```
MemoType : TradeFlow/TradeID
MemoData : <trade-id>          e.g. TF-A1B2C3D4
```

### Reconciliation memo
```
MemoType : TradeFlow/Reconciliation
MemoData : {"tradeId":"...","totalCost":5000,"yourShare":2500,"invoiceHash":"..."}
```

### Invoice hash memo
```
MemoType : TradeFlow/InvoiceHash
MemoData : <sha256-of-invoice-document>
```

---

## XRPL Hooks (Future)

[XRPL Hooks](https://hooks.xrpl.org/) allow WebAssembly logic to run directly
on validators. Planned hooks for TradeFlow:

- **`trade-escrow.c`** — Auto-release escrow when both parties submit matching
  reconciliation memos
- **`invoice-guard.c`** — Reject payments that reference an unknown trade ID

Hooks will live in this directory as `.c` source files once the Hooks amendment
is enabled on mainnet.

---

## Testnet

All current logic runs on **XRPL Altnet** (testnet):

- Explorer: https://testnet.xrpl.org
- Faucet: https://faucet.altnet.rippletest.net/accounts
- WebSocket: `wss://s.altnet.rippletest.net:51233`

Run the full demo: `node scripts/testnet-demo.js`
