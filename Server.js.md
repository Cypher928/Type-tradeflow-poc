# Server.js  
  
const express = require("express");  
const app = express();  
app.use(express.json());  
  
// In-memory trade store (mock database)  
let trades = [];  
  
// 1️⃣ Create Trade  
app.post("/trade", (req, res) => {  
  const trade = {  
    id: trades.length + 1,  
    counterparty: req.body.counterparty,  
    value: req.body.value,  
    status: "CREATED"  
  };  
  trades.push(trade);  
  res.json(trade);  
});  
  
// 2️⃣ Reconciliation  
app.post("/trade/:id/reconcile", (req, res) => {  
  const trade = trades.find(t => t.id == req.params.id);  
  if (!trade) return res.status(404).send("Trade not found");  
  
  trade.status = "RECONCILED";  
  res.json({  
    message: "Reconciliation finalized (on-chain event simulated)",  
    trade  
  });  
});  
  
// 3️⃣ Settlement Trigger  
app.post("/trade/:id/settle", (req, res) => {  
  const trade = trades.find(t => t.id == req.params.id);  
  if (!trade) return res.status(404).send("Trade not found");  
  
  trade.status = "SETTLED";  
  res.json({  
    message: "Settlement triggered via stablecoin (simulated XRPL transaction)",  
    trade  
  });  
});  
  
// View all trades  
app.get("/trades", (req, res) => {  
  res.json(trades);  
});  
  
app.listen(3000, () => {  
  console.log("TradeFlow PoC running on port 3000");  
});  
