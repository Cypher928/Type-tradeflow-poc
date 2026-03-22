require(‘dotenv’).config();
const express = require(‘express’);
const xrpl = require(‘xrpl’); // fix: was ‘xrpl-client’
const crypto = require(‘crypto’);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ─── XRPL Client (persistent connection, not per-request) ────────────────────
// Fix: was reconnecting on every call which causes issues under load
const client = new xrpl.Client(process.env.XRPL_NODE || ‘wss://s.altnet.rippletest.net:51233’);

async function getClient() {
if (!client.isConnected()) await client.connect();
return client;
}

// ─── In-memory trade store (your existing pattern, kept as-is) ───────────────
const trades = new Map();

// ─── Your original /settle endpoint — upgraded to support RLUSD ──────────────
app.post(’/settle’, async (req, res) => {
const { amount, currency } = req.body; // added currency param
const walletSeed = process.env.XRPL_WALLET_SEED;
const destinationAddress = process.env.XRPL_DESTINATION_ADDRESS;

if (!amount) return res.status(400).json({ error: ‘Amount is required.’ });

try {
const result = await sendPayment(walletSeed, destinationAddress, amount, currency || ‘XRP’);
res.status(200).json({ success: true, hash: result.hash, explorerUrl: result.explorerUrl });
} catch (error) {
console.error(error);
res.status(500).json({ error: error.message }); // fix: was swallowing error detail
}
});

// ─── New: Trade endpoints (your README promises these) ───────────────────────

// POST /trade — create a new trade
app.post(’/trade’, (req, res) => {
const { counterpartyName, counterpartyAddress, totalValue, dueDate } = req.body;
if (!counterpartyName || !counterpartyAddress || !totalValue || !dueDate) {
return res.status(400).json({ error: ‘counterpartyName, counterpartyAddress, totalValue, dueDate required’ });
}

const id = ‘TF-’ + crypto.randomBytes(4).toString(‘hex’).toUpperCase();
const trade = {
id,
counterpartyName,
counterpartyAddress,
totalValue: parseFloat(totalValue),
dueDate,
status: ‘active’,
createdAt: new Date().toISOString(),
reconciliation: null,
settlement: null,
};

trades.set(id, trade);
console.log(`📦 Trade created: ${id}`);
res.status(201).json({ success: true, trade });
});

// GET /trades — list all trades
app.get(’/trades’, (req, res) => {
res.json({ success: true, trades: Array.from(trades.values()) });
});

// POST /trade/:id/reconcile — record reconciliation on-chain
app.post(’/trade/:id/reconcile’, async (req, res) => {
const trade = trades.get(req.params.id);
if (!trade) return res.status(404).json({ error: ‘Trade not found’ });

const { walletSeed, yourShare, invoiceHash } = req.body;
if (!walletSeed || yourShare === undefined) {
return res.status(400).json({ error: ‘walletSeed and yourShare are required’ });
}

try {
const result = await recordReconciliation(walletSeed, {
tradeId: trade.id,
totalCost: trade.totalValue,
yourShare: parseFloat(yourShare),
counterparty: trade.counterpartyAddress,
invoiceHash: invoiceHash || crypto.createHash(‘sha256’).update(trade.id).digest(‘hex’),
});

```
trade.reconciliation = { yourShare: parseFloat(yourShare), onChain: result, recordedAt: new Date().toISOString() };
trade.status = 'reconciled';

res.json({ success: true, trade, onChain: result });
```

} catch (error) {
res.status(500).json({ error: error.message });
}
});

// POST /trade/:id/settle — your original sendTestPayment logic, now wired to a trade
app.post(’/trade/:id/settle’, async (req, res) => {
const trade = trades.get(req.params.id);
if (!trade) return res.status(404).json({ error: ‘Trade not found’ });

const { senderSeed, currency } = req.body;
if (!senderSeed) return res.status(400).json({ error: ‘senderSeed is required’ });

const amount = trade.reconciliation
? String(trade.reconciliation.yourShare)
: String(trade.totalValue);

try {
const result = await sendPayment(
senderSeed,
trade.counterpartyAddress,
amount,
currency || ‘RLUSD’,
trade.id
);

```
trade.settlement = { amount, currency: currency || 'RLUSD', onChain: result, settledAt: new Date().toISOString() };
trade.status = 'settled';

res.json({ success: true, trade, onChain: result });
```

} catch (error) {
res.status(500).json({ error: error.message });
}
});

// ─── Core payment function (your original sendTestPayment, upgraded) ──────────
async function sendPayment(seed, destination, amount, currency = ‘XRP’, tradeId = null) {
const c = await getClient();
const wallet = xrpl.Wallet.fromSeed(seed); // fix: was { Wallet: wallet } (capital W = bug)

// Build Amount: XRP uses drops string, RLUSD uses token object
const RLUSD_ISSUER = process.env.RLUSD_ISSUER || ‘rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh’;
const paymentAmount = currency === ‘XRP’
? xrpl.xrpToDrops(amount)
: {
currency: ‘524C555344000000000000000000000000000000’, // RLUSD hex
issuer: RLUSD_ISSUER,
value: String(amount),
};

const tx = {
TransactionType: ‘Payment’,
Account: wallet.address,
Destination: destination,
Amount: paymentAmount,
…(tradeId && {
Memos: [{
Memo: {
MemoType: Buffer.from(‘TradeFlow/TradeID’, ‘utf8’).toString(‘hex’).toUpperCase(),
MemoData: Buffer.from(tradeId, ‘utf8’).toString(‘hex’).toUpperCase(),
}
}]
}),
};

const response = await c.submitAndWait(tx, { wallet }); // fix: was { Wallet: wallet }
console.log(‘Transaction response:’, response.result.hash);

return {
hash: response.result.hash,
status: response.result.meta.TransactionResult,
explorerUrl: `https://testnet.xrpl.org/transactions/${response.result.hash}`,
};
}

// ─── Reconciliation on-chain record ──────────────────────────────────────────
async function recordReconciliation(seed, data) {
const c = await getClient();
const wallet = xrpl.Wallet.fromSeed(seed);

const tx = {
TransactionType: ‘Payment’,
Account: wallet.address,
Destination: data.counterparty,
Amount: ‘1’, // 1 drop — minimal memo transaction
Memos: [{
Memo: {
MemoType: Buffer.from(‘TradeFlow/Reconciliation’, ‘utf8’).toString(‘hex’).toUpperCase(),
MemoData: Buffer.from(JSON.stringify(data), ‘utf8’).toString(‘hex’).toUpperCase(),
}
}],
};

const response = await c.submitAndWait(tx, { wallet });
return {
hash: response.result.hash,
status: response.result.meta.TransactionResult,
explorerUrl: `https://testnet.xrpl.org/transactions/${response.result.hash}`,
};
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get(’/health’, (req, res) => {
res.json({ status: ‘ok’, network: ‘XRPL Testnet’, timestamp: new Date().toISOString() });
});

// ─── Start (your original pattern, kept as-is) ───────────────────────────────
app.listen(port, () => {
console.log(`Server running on port ${port}`);
});
