require('dotenv').config();
const express = require('express');
const xrpl = require('xrpl');
const crypto = require('crypto');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── XRPL Client (persistent connection, not per-request) ────────────────────
const client = new xrpl.Client(process.env.XRPL_NODE || 'wss://s.altnet.rippletest.net:51233');

async function getClient() {
  if (!client.isConnected()) await client.connect();
  return client;
}

// ─── In-memory trade store ────────────────────────────────────────────────────
const trades = new Map();

// ─── /settle endpoint — supports XRP and RLUSD ───────────────────────────────
app.post('/settle', async (req, res) => {
  const { amount, currency } = req.body;
  const walletSeed = process.env.XRPL_WALLET_SEED;
  const destinationAddress = process.env.XRPL_DESTINATION_ADDRESS;

  if (!amount) return res.status(400).json({ error: 'Amount is required.' });

  try {
    const result = await sendPayment(walletSeed, destinationAddress, amount, currency || 'XRP');
    res.status(200).json({ success: true, hash: result.hash, explorerUrl: result.explorerUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Trade endpoints ──────────────────────────────────────────────────────────

// POST /trade — create a new trade
app.post('/trade', (req, res) => {
  const { counterpartyName, counterpartyAddress, totalValue, dueDate } = req.body;
  if (!counterpartyName || !counterpartyAddress || !totalValue || !dueDate) {
    return res.status(400).json({ error: 'counterpartyName, counterpartyAddress, totalValue, dueDate required' });
  }

  const id = 'TF-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const trade = {
    id,
    counterpartyName,
    counterpartyAddress,
    totalValue: parseFloat(totalValue),
    dueDate,
    status: 'active',
    createdAt: new Date().toISOString(),
    reconciliation: null,
    settlement: null,
  };

  trades.set(id, trade);
  console.log(`Trade created: ${id}`);
  res.status(201).json({ success: true, trade });
});

// GET /trades — list all trades
app.get('/trades', (req, res) => {
  res.json({ success: true, trades: Array.from(trades.values()) });
});

// POST /trade/:id/reconcile — record reconciliation on-chain
app.post('/trade/:id/reconcile', async (req, res) => {
  const trade = trades.get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const { walletSeed, yourShare, invoiceHash } = req.body;
  if (!walletSeed || yourShare === undefined) {
    return res.status(400).json({ error: 'walletSeed and yourShare are required' });
  }

  try {
    const result = await recordReconciliation(walletSeed, {
      tradeId: trade.id,
      totalCost: trade.totalValue,
      yourShare: parseFloat(yourShare),
      counterparty: trade.counterpartyAddress,
      invoiceHash: invoiceHash || crypto.createHash('sha256').update(trade.id).digest('hex'),
    });

    trade.reconciliation = { yourShare: parseFloat(yourShare), onChain: result, recordedAt: new Date().toISOString() };
    trade.status = 'reconciled';

    res.json({ success: true, trade, onChain: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /trade/:id/settle — settle a trade on-chain
app.post('/trade/:id/settle', async (req, res) => {
  const trade = trades.get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const { senderSeed, currency } = req.body;
  if (!senderSeed) return res.status(400).json({ error: 'senderSeed is required' });

  const amount = trade.reconciliation
    ? String(trade.reconciliation.yourShare)
    : String(trade.totalValue);

  try {
    const result = await sendPayment(
      senderSeed,
      trade.counterpartyAddress,
      amount,
      currency || 'RLUSD',
      trade.id
    );

    trade.settlement = { amount, currency: currency || 'RLUSD', onChain: result, settledAt: new Date().toISOString() };
    trade.status = 'settled';

    res.json({ success: true, trade, onChain: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Core payment function ────────────────────────────────────────────────────
async function sendPayment(seed, destination, amount, currency = 'XRP', tradeId = null) {
  const c = await getClient();
  const wallet = xrpl.Wallet.fromSeed(seed);

  const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
  const paymentAmount = currency === 'XRP'
    ? xrpl.xrpToDrops(amount)
    : {
        currency: '524C555344000000000000000000000000000000',
        issuer: RLUSD_ISSUER,
        value: String(amount),
      };

  const tx = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: destination,
    Amount: paymentAmount,
    ...(tradeId && {
      Memos: [{
        Memo: {
          MemoType: Buffer.from('TradeFlow/TradeID', 'utf8').toString('hex').toUpperCase(),
          MemoData: Buffer.from(tradeId, 'utf8').toString('hex').toUpperCase(),
        }
      }]
    }),
  };

  const prepared = await c.autofill(tx);
  const signed = wallet.sign(prepared);
  const response = await c.submitAndWait(signed.tx_blob);
  console.log('Transaction response:', response.result.hash);

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
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: data.counterparty,
    Amount: '1',
    Memos: [{
      Memo: {
        MemoType: Buffer.from('TradeFlow/Reconciliation', 'utf8').toString('hex').toUpperCase(),
        MemoData: Buffer.from(JSON.stringify(data), 'utf8').toString('hex').toUpperCase(),
      }
    }],
  };

  const prepared = await c.autofill(tx);
  const signed = wallet.sign(prepared);
  const response = await c.submitAndWait(signed.tx_blob);
  return {
    hash: response.result.hash,
    status: response.result.meta.TransactionResult,
    explorerUrl: `https://testnet.xrpl.org/transactions/${response.result.hash}`,
  };
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', network: 'XRPL Testnet', timestamp: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
