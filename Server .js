require('dotenv').config();
const express = require('express');
const xrpl = require('xrpl-client'); // Assuming you're using a library for XRPL client

const app = express();
const port = process.env.PORT || 3000;

const xrplClient = new xrpl.Client(process.env.XRPL_NODE);

app.use(express.json());

app.post('/settle', async (req, res) => {
    const { amount } = req.body;
    const walletSeed = process.env.XRPL_WALLET_SEED;
    const destinationAddress = process.env.XRPL_DESTINATION_ADDRESS;

    if (!amount) {
        return res.status(400).send('Amount is required.');
    }

    try {
        // Example of sending a test payment. You'll have to implement the `sendTestPayment` function.
        await sendTestPayment(xrplClient, walletSeed, destinationAddress, amount);
        res.status(200).send('Payment sent successfully.');
    } catch (error) {
        console.error(error);
        res.status(500).send('An error occurred while sending the payment.');
    }
});

async function sendTestPayment(client, seed, destination, amount) {
    const wallet = xrpl.Wallet.fromSeed(seed);
    const transaction = {
        TransactionType: 'Payment',
        Account: wallet.address,
        Destination: destination,
        Amount: xrpl.xrpToDrops(amount),
    };

    await client.connect();
    const response = await client.submitAndWait(transaction, { Wallet: wallet });
    await client.disconnect();
    console.log('Transaction response:', response);
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});


