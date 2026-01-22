const xrpl = require("xrpl")

const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233")

async function connectXRPL() {
  if (!client.isConnected()) {
    await client.connect()
    console.log("✅ Connected to XRPL Testnet")
  }
  return client
}

async function sendTestPayment({ fromSeed, toAddress, amount, memo }) {
  const client = await connectXRPL()
  const wallet = xrpl.Wallet.fromSeed(fromSeed)

  const tx = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Amount: xrpl.xrpToDrops(amount),
    Destination: toAddress,
    Memos: memo
      ? [
          {
            Memo: {
              MemoType: Buffer.from("trade").toString("hex"),
              MemoData: Buffer.from(memo).toString("hex")
            }
          }
        ]
      : []
  }

  const prepared = await client.autofill(tx)
  const signed = wallet.sign(prepared)
  const result = await client.submitAndWait(signed.tx_blob)

  return result
}

module.exports = { sendTestPayment }
