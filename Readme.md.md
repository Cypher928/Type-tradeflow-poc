# Readme.md  
  
# TradeFlow Ledger – Proof of Concept  
  
This repository contains a backend Proof of Concept for TradeFlow Ledger, a trade finance and settlement platform built for the XRP Ledger ecosystem.  
  
## Purpose  
This PoC demonstrates how trade lifecycle events generate on-chain activity on XRPL, including:  
- Trade creation  
- Reconciliation finalization  
- Settlement via stablecoin payments (RLUSD / USDC)  
  
## Architecture  
- Node.js + Express backend  
- Simulated XRPL interactions  
- Designed to integrate with XRPL EVM sidechain smart contracts  
  
## API Endpoints  
- POST /trade – Create a new trade  
- POST /trade/:id/reconcile – Finalize reconciliation (on-chain trigger)  
- POST /trade/:id/settle – Trigger stablecoin settlement  
- GET /trades – View all trades  
  
## XRPL Alignment  
In production, reconciliation and settlement endpoints would trigger:  
- XRPL smart contract calls  
- Stablecoin payments using RLUSD or USDC  
- Immutable on-chain settlement records  
  
## Status  
Backend architecture Proof of Concept for XRPL Grants application.  
