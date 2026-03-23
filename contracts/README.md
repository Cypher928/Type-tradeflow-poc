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

## EVM Sidechain — Solidity Escrow Contract

`TradeFlowEscrow.sol` is a simple Solidity escrow deployable on the
**XRPL EVM Sidechain Devnet** (Chain ID 1440002).

### What it does

| Function | Description |
|----------|-------------|
| `createEscrow(exporter, releaseDelay, refundDelay, tradeId)` | Importer deposits funds; locks until time-lock passes |
| `release(id)` | Exporter claims funds after release time-lock |
| `refund(id)` | Importer reclaims funds after refund time-lock |

The `tradeId` field mirrors the XRPL memo so the same trade can be tracked
across both the native ledger and the EVM sidechain.

### Deploy to XRPL EVM Devnet

```bash
# Install Hardhat
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox

# In hardhat.config.js add:
networks: {
  xrplEvmDevnet: {
    url: "https://rpc.evm.devnet.ripple.com",
    chainId: 1440002,
    accounts: [process.env.EVM_PRIVATE_KEY]
  }
}

# Deploy
npx hardhat run scripts/deploy.js --network xrplEvmDevnet
```

Explorer: https://evm-sidechain.xrpl.org

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
