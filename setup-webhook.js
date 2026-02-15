import 'dotenv/config';
import { COL_DATA } from './src/data.js';

// ============================
// Kolscam: Register Helius Enhanced Webhook
// Run once: node setup-webhook.js
// ============================

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://yourdomain.com/webhook/helius

if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY not set in .env');
    process.exit(1);
}
if (!WEBHOOK_URL) {
    console.error('❌ WEBHOOK_URL not set in .env');
    console.error('   Set it to your public server URL + /webhook/helius');
    console.error('   Example: WEBHOOK_URL=https://abc123.ngrok.io/webhook/helius');
    process.exit(1);
}

// Auto-build wallet list from data.js (main + side wallets, deduplicated)
const walletSet = new Set();
for (const kol of COL_DATA) {
    // Main wallet
    if (kol['Wallet Address'] && kol['Wallet Address'].length > 10) {
        walletSet.add(kol['Wallet Address']);
    }
    // Side wallets
    if (Array.isArray(kol['Side Wallets'])) {
        for (const sw of kol['Side Wallets']) {
            if (sw && sw.length > 10) walletSet.add(sw);
        }
    }
}
const WALLETS = [...walletSet];
console.log(`📊 ${COL_DATA.length} KOLs → ${WALLETS.length} unique wallets (main + side)`);

async function createWebhook() {
    console.log(`\n🔧 Registering Helius webhook for ${WALLETS.length} wallets...`);
    console.log(`   URL: ${WEBHOOK_URL}\n`);

    try {
        const res = await fetch(
            `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhookURL: WEBHOOK_URL,
                    transactionTypes: ['SWAP'],
                    accountAddresses: WALLETS,
                    webhookType: 'enhanced',
                    txnStatus: 'success',
                })
            }
        );

        if (!res.ok) {
            const err = await res.text();
            console.error(`❌ Failed (${res.status}):`, err);
            process.exit(1);
        }

        const data = await res.json();
        console.log(`✅ Webhook created!`);
        console.log(`   Webhook ID: ${data.webhookID}`);
        console.log(`   Monitoring ${WALLETS.length} wallets for SWAP transactions`);
        console.log(`\n   💡 Save this ID in your .env as WEBHOOK_ID=${data.webhookID}`);
        console.log(`   💡 To update wallets later: node setup-webhook.js update\n`);

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

async function listWebhooks() {
    try {
        const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`);
        const data = await res.json();
        console.log(`\n📋 Your Helius webhooks:\n`);
        for (const wh of data) {
            console.log(`   ID: ${wh.webhookID}`);
            console.log(`   URL: ${wh.webhookURL}`);
            console.log(`   Type: ${wh.webhookType}`);
            console.log(`   Wallets: ${wh.accountAddresses?.length || 0}`);
            console.log(`   Tx Types: ${wh.transactionTypes?.join(', ')}`);
            console.log('');
        }
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

async function deleteWebhook(id) {
    try {
        const res = await fetch(
            `https://api.helius.xyz/v0/webhooks/${id}?api-key=${HELIUS_API_KEY}`,
            { method: 'DELETE' }
        );
        if (res.ok) {
            console.log(`✅ Webhook ${id} deleted`);
        } else {
            console.error(`❌ Failed:`, await res.text());
        }
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

// CLI
const action = process.argv[2] || 'create';

if (action === 'create') {
    createWebhook();
} else if (action === 'list') {
    listWebhooks();
} else if (action === 'delete') {
    const id = process.argv[3] || process.env.WEBHOOK_ID;
    if (!id) {
        console.error('❌ Provide webhook ID: node setup-webhook.js delete <WEBHOOK_ID>');
        process.exit(1);
    }
    deleteWebhook(id);
} else {
    console.log('Usage:');
    console.log('  node setup-webhook.js create  - Register webhook with Helius');
    console.log('  node setup-webhook.js list    - List all your webhooks');
    console.log('  node setup-webhook.js delete <ID> - Delete a webhook');
}
