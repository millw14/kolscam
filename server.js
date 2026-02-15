import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
    insertWallet, getAllWallets, getWalletByAddress,
    getCachedToken, upsertTokenCache, upsertTokenMarketData,
    insertTrade, getRecentTrades, getRecentTradesRaw, getTradesSince,
    getLeaderboardStats, getRecentTokens, getTokenKolPositions,
    getTradeCount, getScannedKolCount
} from './db.js';
import { COL_DATA } from './src/data.js';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_BASE = `https://api.helius.xyz`;

// Gate Helius usage behind a flag — set HELIUS_ENABLED=true when ready
const HELIUS_ENABLED = process.env.HELIUS_ENABLED === 'true';

// Pre-build wallet→avatar map for fast lookups (main + side wallets)
const WALLET_AVATAR_MAP = {};
const WALLET_KOL_MAP = {};
const SIDE_WALLET_SET = new Set(); // Track which wallets are side wallets
for (const kol of COL_DATA) {
    if (kol['Wallet Address']) {
        WALLET_AVATAR_MAP[kol['Wallet Address']] = kol.Avatar || '/logo.png';
        WALLET_KOL_MAP[kol['Wallet Address']] = kol;
    }
    // Map side wallets back to the same KOL
    if (Array.isArray(kol['Side Wallets'])) {
        for (const sw of kol['Side Wallets']) {
            if (sw && sw.length > 10 && sw !== kol['Wallet Address']) {
                WALLET_AVATAR_MAP[sw] = kol.Avatar || '/logo.png';
                WALLET_KOL_MAP[sw] = kol;
                SIDE_WALLET_SET.add(sw);
            }
        }
    }
}

app.use(cors());
app.use(express.json());

// Serve static files: avatars from public/, built frontend from dist/
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'dist')));

// ============================
// SOL Price Tracker
// ============================

let SOL_PRICE_USD = 80; // default fallback
let heliusCreditEstimate = 0; // rough credit counter for monitoring

async function fetchSolPrice() {
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (res.ok) {
            const data = await res.json();
            if (data.solana?.usd) {
                SOL_PRICE_USD = data.solana.usd;
                console.log(`💰 SOL price: $${SOL_PRICE_USD}`);
            }
        }
    } catch (err) {
        // Try Jupiter as fallback
        try {
            const res2 = await fetch('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
            if (res2.ok) {
                const data2 = await res2.json();
                const price = data2.data?.['So11111111111111111111111111111111111111112']?.price;
                if (price) {
                    SOL_PRICE_USD = parseFloat(price);
                    console.log(`💰 SOL price (Jupiter): $${SOL_PRICE_USD}`);
                }
            }
        } catch { /* silent */ }
    }
}

// ============================
// DexScreener API
// ============================

async function fetchDexScreenerData(mints) {
    if (!mints || mints.length === 0) return {};

    const results = {};

    // Process in batches of 30 (DexScreener limit)
    for (let i = 0; i < mints.length; i += 30) {
        const batch = mints.slice(i, i + 30);
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`;
            const res = await fetch(url);
            if (!res.ok) continue;

            const data = await res.json();
            if (!data.pairs) continue;

            // Group pairs by base token, pick the most liquid pair
            const tokenPairs = {};
            for (const pair of data.pairs) {
                if (pair.chainId !== 'solana') continue;
                const mint = pair.baseToken?.address;
                if (!mint) continue;

                if (!tokenPairs[mint] || (pair.liquidity?.usd || 0) > (tokenPairs[mint].liquidity?.usd || 0)) {
                    tokenPairs[mint] = pair;
                }
            }

            for (const [mint, pair] of Object.entries(tokenPairs)) {
                const tokenData = {
                    mint,
                    name: pair.baseToken?.name || '',
                    symbol: pair.baseToken?.symbol || '',
                    image: pair.info?.imageUrl || '',
                    priceUsd: parseFloat(pair.priceUsd || 0),
                    mcap: pair.fdv || pair.marketCap || 0,
                    priceChange24h: pair.priceChange?.h24 || 0,
                    liquidity: pair.liquidity?.usd || 0,
                    volume24h: pair.volume?.h24 || 0,
                };

                results[mint] = tokenData;

                // Cache in DB
                try {
                    upsertTokenMarketData.run(
                        mint,
                        tokenData.name,
                        tokenData.symbol,
                        tokenData.image,
                        tokenData.mcap,
                        tokenData.priceUsd,
                        tokenData.priceChange24h
                    );
                } catch { /* silent */ }
            }

            // Small delay between batches
            if (i + 30 < mints.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (err) {
            console.error('DexScreener error:', err.message);
        }
    }

    return results;
}

// ============================
// Helius API Helpers
// ============================

async function fetchEnhancedTransactions(walletAddress, limit = 50) {
    if (!HELIUS_ENABLED || !HELIUS_API_KEY) return [];
    const url = `${HELIUS_BASE}/v0/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`;
    try {
        const res = await fetch(url);
        heliusCreditEstimate += 100;
        if (!res.ok) return [];
        return await res.json();
    } catch (err) {
        return [];
    }
}

async function batchGetTokenMetadata(mints) {
    if (!HELIUS_ENABLED || !HELIUS_API_KEY) return {};
    const uncached = mints.filter(m => {
        if (m === 'So11111111111111111111111111111111111111112') return false;
        return !getCachedToken.get(m);
    });

    if (uncached.length > 0) {
        try {
            for (let i = 0; i < uncached.length; i += 100) {
                const chunk = uncached.slice(i, i + 100);
                const res = await fetch(`${HELIUS_BASE}/v0/token-metadata?api-key=${HELIUS_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mintAccounts: chunk, includeOffChain: true, disableCache: false })
                });
                if (res.ok) {
                    const data = await res.json();
                    for (const token of data) {
                        const mint = token.account;
                        const offChain = token.offChainMetadata?.metadata || {};
                        const onChain = token.onChainMetadata?.metadata?.data || {};
                        const name = offChain.name || onChain.name || '';
                        const symbol = offChain.symbol || onChain.symbol || '';
                        const image = offChain.image || '';
                        if (symbol) upsertTokenCache.run(mint, name, symbol, image);
                    }
                }
            }
        } catch (err) { /* silent */ }
    }

    const results = {};
    for (const mint of mints) {
        if (mint === 'So11111111111111111111111111111111111111112') {
            results[mint] = { name: 'Wrapped SOL', symbol: 'SOL', image: '' };
            continue;
        }
        const cached = getCachedToken.get(mint);
        results[mint] = cached
            ? { name: cached.name, symbol: cached.symbol, image: cached.image }
            : null;
    }
    return results;
}

// ============================
// Transaction Parser (Buy/Sell only)
// ============================

function parseTransaction(tx, kolName, kolAvatar, walletAddress, tokenMetadataMap) {
    const result = {
        signature: tx.signature,
        timestamp: tx.timestamp,
        kolName: kolName || 'Unknown',
        kolAvatar: kolAvatar || '/logo.png',
        action: null,
        tokenSymbol: null,
        tokenMint: '',
        tokenAmount: 0,
        amountSol: 0,
    };

    // Extract token mint from tokenTransfers
    let primaryMint = '';
    let primaryTokenAmount = 0;

    if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
        for (const transfer of tx.tokenTransfers) {
            if (transfer.mint && transfer.mint !== 'So11111111111111111111111111111111111111112') {
                primaryMint = transfer.mint;
                primaryTokenAmount = Math.abs(transfer.tokenAmount || 0);
                break;
            }
        }
    }

    // STRATEGY 1: Parse Helius description (most reliable)
    const swapMatch = tx.description?.match(/swapped\s+([\d,.]+)\s+(\S+)\s+for\s+([\d,.]+)\s+(\S+)/i);
    if (swapMatch) {
        const [, amt1, tok1, amt2, tok2] = swapMatch;
        if (tok1.toUpperCase() === 'SOL') {
            result.action = 'Buy';
            result.tokenSymbol = tok2;
            result.amountSol = parseFloat(amt1.replace(/,/g, ''));
            result.tokenAmount = parseFloat(amt2.replace(/,/g, '')) || primaryTokenAmount;
        } else if (tok2.toUpperCase() === 'SOL') {
            result.action = 'Sell';
            result.tokenSymbol = tok1;
            result.amountSol = parseFloat(amt2.replace(/,/g, ''));
            result.tokenAmount = parseFloat(amt1.replace(/,/g, '')) || primaryTokenAmount;
        } else {
            // Token-to-token swap (not SOL), skip
            return null;
        }

        result.tokenMint = primaryMint;

        // If we didn't get token mint from transfers, try to look up by symbol
        if (!result.tokenMint && tokenMetadataMap) {
            for (const [mint, meta] of Object.entries(tokenMetadataMap)) {
                if (meta && meta.symbol === result.tokenSymbol) {
                    result.tokenMint = mint;
                    break;
                }
            }
        }

        return result;
    }

    // Skip transfers entirely - we only want buy/sell
    const transferMatch = tx.description?.match(/transferred/i);
    if (transferMatch) return null;

    // STRATEGY 2: Token transfers + metadata map
    if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
        for (const transfer of tx.tokenTransfers) {
            if (transfer.mint && transfer.mint !== 'So11111111111111111111111111111111111111112') {
                const metadata = tokenMetadataMap?.[transfer.mint];
                if (metadata && metadata.symbol && metadata.symbol.length <= 12) {
                    result.tokenSymbol = metadata.symbol;
                }
                result.tokenMint = transfer.mint;
                result.tokenAmount = Math.abs(transfer.tokenAmount || 0);
                result.action = transfer.toUserAccount === walletAddress ? 'Buy' : 'Sell';
                break;
            }
        }
    }

    // If no action determined, skip
    if (!result.action) return null;

    // STRATEGY 3: SOL amount from native transfers
    if (tx.nativeTransfers && tx.nativeTransfers.length > 0 && result.amountSol === 0) {
        let solAmount = 0;
        for (const t of tx.nativeTransfers) {
            if (t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress) {
                solAmount = Math.max(solAmount, Math.abs(t.amount));
            }
        }
        if (solAmount === 0 && tx.nativeTransfers.length > 0) {
            solAmount = Math.max(...tx.nativeTransfers.map(t => Math.abs(t.amount)));
        }
        result.amountSol = parseFloat((solAmount / 1e9).toFixed(4));
    }

    return result;
}

// Tokens to skip -- these are not memecoins
const SKIP_TOKENS = new Set([
    'SOL', 'WSOL', 'USDC', 'USDT', 'USDS',
    'mSOL', 'jitoSOL', 'bSOL', 'stSOL', 'JitoSOL',
    'WETH', 'WBTC', 'RAY', 'JLP', 'JTO', 'PYTH', 'JUP',
    'BONK', // too common/stable
]);

// Known stablecoin / infrastructure mints to skip
const SKIP_MINTS = new Set([
    'So11111111111111111111111111111111111111112',  // Wrapped SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

function isValidTrade(trade) {
    if (!trade) return false;
    if (!trade.action || (trade.action !== 'Buy' && trade.action !== 'Sell')) return false;
    const sym = trade.tokenSymbol;
    if (!sym || sym.length > 15) return false;
    if (/^[a-f0-9]{6,}$/i.test(sym)) return false;
    if (trade.amountSol <= 0) return false;
    // Skip non-memecoin tokens
    if (SKIP_TOKENS.has(sym)) return false;
    if (trade.tokenMint && SKIP_MINTS.has(trade.tokenMint)) return false;
    return true;
}

// ============================
// Background Scanner (catchup/backfill only)
// Webhooks handle real-time. This runs every 6 hours
// to catch anything webhooks might have missed.
// ============================

let scannerPhase = 'idle';
let scanProgress = { done: 0, total: 0 };

async function scanKolWallet(kol) {
    const wallet = kol['Wallet Address'];
    if (!wallet || wallet.length < 10) return 0;

    try {
        const txs = await fetchEnhancedTransactions(wallet, 10);
        if (!txs || txs.length === 0) return 0;

        const mints = new Set();
        for (const tx of txs) {
            if (tx.tokenTransfers) {
                for (const t of tx.tokenTransfers) {
                    if (t.mint) mints.add(t.mint);
                }
            }
        }
        const tokenMeta = await batchGetTokenMetadata([...mints]);

        let saved = 0;
        for (const tx of txs) {
            const trade = parseTransaction(tx, kol.Name, kol.Avatar, wallet, tokenMeta);

            if (isValidTrade(trade) && trade.signature) {
                try {
                    insertTrade.run(
                        wallet,
                        trade.kolName,
                        trade.kolAvatar || '',
                        trade.action,
                        trade.tokenSymbol,
                        trade.amountSol,
                        trade.signature,
                        trade.timestamp || 0,
                        trade.tokenMint || '',
                        trade.tokenAmount || 0
                    );
                    saved++;
                } catch (e) { /* duplicate */ }
            }
        }
        return saved;
    } catch (err) {
        return 0;
    }
}

async function runBackgroundScan() {
    if (scannerPhase === 'scanning') return;
    scannerPhase = 'scanning';

    const validKols = COL_DATA.filter(k => k['Wallet Address'] && k['Wallet Address'].length > 10);
    const shuffled = [...validKols].sort(() => Math.random() - 0.5);

    scanProgress = { done: 0, total: shuffled.length };
    console.log(`\n🔍 Background scan: ${shuffled.length} KOL wallets (10 txns each)...\n`);

    let totalSaved = 0;

    for (let i = 0; i < shuffled.length; i += 5) {
        const group = shuffled.slice(i, i + 5);
        const results = await Promise.all(group.map(kol => scanKolWallet(kol)));
        const groupSaved = results.reduce((a, b) => a + b, 0);
        totalSaved += groupSaved;
        scanProgress.done = Math.min(i + 5, shuffled.length);

        if (groupSaved > 0) {
            console.log(`   [${scanProgress.done}/${shuffled.length}] ${group.map(k => k.Name).join(', ')} +${groupSaved}`);
        }

        await new Promise(r => setTimeout(r, 500));
    }

    const stats = getTradeCount.get();
    const kolCount = getScannedKolCount.get();
    console.log(`\n✅ Background scan done: +${totalSaved} trades | DB: ${stats.count} trades from ${kolCount.count} KOLs\n`);

    scannerPhase = 'done';
    refreshTokenMarketData();
}

// Refresh DexScreener market data for recently active tokens
async function refreshTokenMarketData() {
    try {
        const since = Math.floor(Date.now() / 1000) - 86400; // last 24h
        const tokens = getRecentTokens.all(since, 100);
        const mints = tokens
            .map(t => t.token_mint)
            .filter(m => m && m.length > 10);

        if (mints.length > 0) {
            console.log(`📊 Refreshing market data for ${mints.length} tokens...`);
            await fetchDexScreenerData(mints);
            console.log(`📊 Market data refresh complete`);
        }
    } catch (err) {
        console.error('Market data refresh error:', err.message);
    }
}

// ============================
// Helius Webhook Receiver
// ============================

app.post('/webhook/helius', async (req, res) => {
    // Respond immediately (Helius expects 200 within 5s)
    res.status(200).json({ received: true });

    if (!HELIUS_ENABLED) return; // Don't process if Helius is disabled

    const transactions = req.body;
    if (!Array.isArray(transactions)) return;

    let saved = 0;
    for (const tx of transactions) {
        try {
            // Find which KOL wallet this belongs to
            const involvedAccounts = new Set();
            if (tx.feePayer) involvedAccounts.add(tx.feePayer);
            if (tx.nativeTransfers) {
                for (const t of tx.nativeTransfers) {
                    if (t.fromUserAccount) involvedAccounts.add(t.fromUserAccount);
                    if (t.toUserAccount) involvedAccounts.add(t.toUserAccount);
                }
            }
            if (tx.tokenTransfers) {
                for (const t of tx.tokenTransfers) {
                    if (t.fromUserAccount) involvedAccounts.add(t.fromUserAccount);
                    if (t.toUserAccount) involvedAccounts.add(t.toUserAccount);
                }
            }

            let kolWallet = null;
            let kol = null;
            for (const account of involvedAccounts) {
                if (WALLET_KOL_MAP[account]) {
                    kolWallet = account;
                    kol = WALLET_KOL_MAP[account];
                    break;
                }
            }

            if (!kolWallet || !kol) continue;

            // Get token metadata for mints in this tx
            const mints = new Set();
            if (tx.tokenTransfers) {
                for (const t of tx.tokenTransfers) {
                    if (t.mint) mints.add(t.mint);
                }
            }
            const tokenMeta = mints.size > 0 ? await batchGetTokenMetadata([...mints]) : {};

            // Parse and save
            const isSideWallet = SIDE_WALLET_SET.has(kolWallet);
            const trade = parseTransaction(tx, kol.Name, kol.Avatar, kolWallet, tokenMeta);
            if (isValidTrade(trade) && trade.signature) {
                try {
                    insertTrade.run(
                        kolWallet, trade.kolName, trade.kolAvatar || '',
                        trade.action, trade.tokenSymbol, trade.amountSol,
                        trade.signature, trade.timestamp || 0,
                        trade.tokenMint || '', trade.tokenAmount || 0
                    );
                    saved++;
                    const walletTag = isSideWallet ? ' [SIDE]' : '';
                    console.log(`🔔 Webhook: ${kol.Name}${walletTag} ${trade.action} ${trade.tokenSymbol} (${trade.amountSol} SOL)`);
                } catch (e) { /* duplicate signature — expected */ }
            }
        } catch (err) {
            console.error('Webhook parse error:', err.message);
        }
    }

    if (saved > 0) {
        console.log(`🔔 Webhook batch: +${saved} new trades saved`);
    }
});

// ============================
// API Routes
// ============================

/**
 * GET /api/sol-price
 */
app.get('/api/sol-price', (req, res) => {
    res.json({ price: SOL_PRICE_USD });
});

/**
 * GET /api/leaderboard?period=daily|weekly|monthly
 */
app.get('/api/leaderboard', (req, res) => {
    try {
        const period = req.query.period || 'daily';
        const now = Math.floor(Date.now() / 1000);

        let since;
        if (period === 'weekly') since = now - 7 * 86400;
        else if (period === 'monthly') since = now - 30 * 86400;
        else since = now - 86400;

        const stats = getLeaderboardStats.all(since, 100);

        const enriched = stats.map((row, idx) => {
            const kol = WALLET_KOL_MAP[row.wallet];
            return {
                rank: idx + 1,
                wallet: row.wallet,
                name: row.kol_name,
                avatar: row.kol_avatar || WALLET_AVATAR_MAP[row.wallet] || '/logo.png',
                twitter: kol?.['Twitter Handle'] || '',
                tradeCount: row.trade_count,
                buyCount: row.buy_count || 0,
                sellCount: row.sell_count || 0,
                pnl: parseFloat(row.pnl?.toFixed(2) || 0),
                pnlUsd: parseFloat((row.pnl * SOL_PRICE_USD).toFixed(1) || 0),
                winRate: parseFloat(row.win_rate?.toFixed(1) || 0),
            };
        });

        const totalTrades = getTradeCount.get();
        const totalKols = getScannedKolCount.get();

        res.json({
            period,
            solPrice: SOL_PRICE_USD,
            leaderboard: enriched,
            meta: {
                totalTrades: totalTrades.count,
                totalKols: totalKols.count,
                scannerPhase,
                scanProgress: scannerPhase === 'scanning' ? `${scanProgress.done}/${scanProgress.total}` : 'idle'
            }
        });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

/**
 * GET /api/trades/feed - Latest trades from DB with token images
 * Diverse feed: max 2 trades per KOL so no single trader floods the feed
 */
app.get('/api/trades/feed', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        // Fetch more than needed, then diversity-filter in JS
        const rawTrades = getRecentTradesRaw.all(Math.max(limit * 10, 200));

        // Filter out non-memecoin tokens that may still be in DB
        const filtered = rawTrades.filter(t => {
            const sym = (t.token_symbol || '').toUpperCase();
            if (SKIP_TOKENS.has(sym) || SKIP_TOKENS.has(t.token_symbol)) return false;
            if (t.token_mint && SKIP_MINTS.has(t.token_mint)) return false;
            return true;
        });

        // Diversity filter: max 2 trades per KOL name
        const kolCounts = {};
        const diverseTrades = [];
        for (const t of filtered) {
            const key = t.kol_name || t.wallet || 'unknown';
            kolCounts[key] = (kolCounts[key] || 0) + 1;
            if (kolCounts[key] <= 2) {
                diverseTrades.push(t);
            }
            if (diverseTrades.length >= limit) break;
        }

        res.json({
            solPrice: SOL_PRICE_USD,
            trades: diverseTrades.map(t => ({
                kolName: t.kol_name,
                kolAvatar: t.kol_avatar || WALLET_AVATAR_MAP[t.wallet] || '/logo.png',
                action: t.action,
                tokenSymbol: t.token_symbol,
                tokenMint: t.token_mint || '',
                tokenAmount: t.token_amount || 0,
                tokenImage: t.token_image || '',
                tokenPrice: t.token_price || 0,
                amountSol: t.amount_sol,
                timestamp: t.tx_timestamp,
                signature: t.signature,
                isSideWallet: SIDE_WALLET_SET.has(t.wallet)
            }))
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

/**
 * GET /api/trades/:wallet - Serve from DB cache (zero Helius credits)
 */
app.get('/api/trades/:wallet', (req, res) => {
    const { wallet } = req.params;
    try {
        const kol = COL_DATA.find(k => k['Wallet Address'] === wallet);

        // Serve from DB — no Helius calls
        const rawTrades = getRecentTradesRaw.all(200)
            .filter(t => t.wallet === wallet);

        const trades = rawTrades.map(t => ({
            kolName: t.kol_name,
            kolAvatar: t.kol_avatar || WALLET_AVATAR_MAP[wallet] || '/logo.png',
            action: t.action,
            tokenSymbol: t.token_symbol,
            tokenMint: t.token_mint || '',
            tokenAmount: t.token_amount || 0,
            amountSol: t.amount_sol,
            timestamp: t.tx_timestamp,
            signature: t.signature,
        }));

        res.json({
            wallet,
            solPrice: SOL_PRICE_USD,
            kol: kol ? { name: kol.Name, twitter: kol['Twitter Handle'], avatar: kol.Avatar } : null,
            trades
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

/**
 * GET /api/kol/:name/sides - Get side wallet trades for a KOL
 */
app.get('/api/kol/:name/sides', (req, res) => {
    const { name } = req.params;
    try {
        const kol = COL_DATA.find(k => k.Name.toLowerCase() === name.toLowerCase());
        if (!kol) return res.status(404).json({ error: 'KOL not found' });

        const sideWallets = (kol['Side Wallets'] || []).filter(
            sw => sw && sw.length > 10 && sw !== kol['Wallet Address']
        );

        // Get trades for each side wallet from DB
        const allTrades = getRecentTradesRaw.all(500);
        const sideTrades = allTrades
            .filter(t => sideWallets.includes(t.wallet))
            .map(t => ({
                wallet: t.wallet,
                action: t.action,
                tokenSymbol: t.token_symbol,
                tokenMint: t.token_mint || '',
                tokenAmount: t.token_amount || 0,
                amountSol: t.amount_sol,
                timestamp: t.tx_timestamp,
                signature: t.signature,
                isSideWallet: true
            }));

        res.json({
            kolName: kol.Name,
            mainWallet: kol['Wallet Address'],
            sideWallets,
            solPrice: SOL_PRICE_USD,
            trades: sideTrades
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

/**
 * GET /api/tokens - Token tracker page data grouped by market cap
 */
app.get('/api/tokens', async (req, res) => {
    try {
        const since = Math.floor(Date.now() / 1000) - 86400; // last 24h
        const tokens = getRecentTokens.all(since, 60);

        // Collect mints that need fresh market data
        const mints = tokens
            .map(t => t.token_mint)
            .filter(m => m && m.length > 10);

        // Fetch market data from DexScreener (or use cached)
        let marketData = {};
        if (mints.length > 0) {
            // Check which ones need refreshing (older than 5 min)
            const freshMints = [];
            for (const mint of mints) {
                const cached = getCachedToken.get(mint);
                if (!cached || !cached.mcap || (Date.now() - new Date(cached.cached_at).getTime() > 5 * 60 * 1000)) {
                    freshMints.push(mint);
                }
            }
            if (freshMints.length > 0) {
                marketData = await fetchDexScreenerData(freshMints);
            }
        }

        // Build token cards with KOL positions
        const tokenCards = [];
        for (const token of tokens) {
            const cached = getCachedToken.get(token.token_mint);
            const dex = marketData[token.token_mint];

            const mcap = dex?.mcap || cached?.mcap || 0;
            const priceUsd = dex?.priceUsd || cached?.price_usd || 0;
            const priceChange = dex?.priceChange24h || cached?.price_change_24h || 0;
            const image = dex?.image || cached?.image || '';
            const name = dex?.name || cached?.name || token.token_symbol;
            const symbol = dex?.symbol || cached?.symbol || token.token_symbol;

            // Get KOL positions
            const positions = getTokenKolPositions.all(token.token_mint, 10);

            tokenCards.push({
                mint: token.token_mint,
                symbol,
                name,
                image,
                mcap,
                priceUsd,
                priceChange,
                tradeCount: token.trade_count,
                kolCount: token.kol_count,
                lastTrade: token.last_trade,
                positions: positions.map(p => ({
                    kolName: p.kol_name,
                    kolAvatar: p.kol_avatar || WALLET_AVATAR_MAP[p.wallet] || '/logo.png',
                    boughtSol: p.total_bought_sol || 0,
                    boughtTokens: p.total_bought_tokens || 0,
                    soldSol: p.total_sold_sol || 0,
                    soldTokens: p.total_sold_tokens || 0,
                    lastTrade: p.last_trade,
                }))
            });
        }

        // Group by market cap tier
        const lowCaps = tokenCards.filter(t => t.mcap > 0 && t.mcap < 100000);
        const midCaps = tokenCards.filter(t => t.mcap >= 100000 && t.mcap < 1000000);
        const highCaps = tokenCards.filter(t => t.mcap >= 1000000);
        const unknown = tokenCards.filter(t => !t.mcap || t.mcap === 0);

        res.json({
            solPrice: SOL_PRICE_USD,
            lowCaps: [...lowCaps, ...unknown].slice(0, 10),
            midCaps: midCaps.slice(0, 10),
            highCaps: highCaps.slice(0, 10),
        });
    } catch (err) {
        console.error('Tokens error:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/scanner/status', (req, res) => {
    const stats = getTradeCount.get();
    const kolCount = getScannedKolCount.get();
    res.json({
        phase: scannerPhase,
        progress: scannerPhase === 'scanning' ? `${scanProgress.done}/${scanProgress.total}` : 'idle',
        totalTrades: stats.count,
        totalKols: kolCount.count,
        solPrice: SOL_PRICE_USD,
        estimatedCreditsUsed: heliusCreditEstimate
    });
});

app.post('/api/wallets', (req, res) => {
    const { address, label, notes } = req.body;
    if (!address || address.length < 32) return res.status(400).json({ error: 'Invalid address' });
    try {
        const existing = getWalletByAddress.get(address);
        if (existing) return res.status(409).json({ error: 'Already submitted', wallet: existing });
        insertWallet.run(address, label || '', notes || '');
        res.status(201).json({ success: true, wallet: getWalletByAddress.get(address) });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/wallets', (req, res) => {
    try { res.json(getAllWallets.all()); }
    catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ============================
// Health check
// ============================
app.get('/health', (req, res) => {
    const stats = getTradeCount.get();
    res.json({ status: 'ok', trades: stats.count, kols: COL_DATA.length, helius: HELIUS_ENABLED });
});

// ============================
// SPA catch-all (serve index.html for all non-API routes)
// Express 5 requires named param for wildcards
// ============================
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================
// Start
// ============================
app.listen(PORT, () => {
    const existing = getTradeCount.get();
    const kolCount = getScannedKolCount.get();
    console.log(`\n🚀 Kolscam API on port ${PORT}`);
    console.log(`   Helius: ${HELIUS_ENABLED ? '✅ ENABLED' : '⏸️  DISABLED (set HELIUS_ENABLED=true to activate)'}  |  KOLs: ${COL_DATA.length}  |  DB: ${existing.count} trades\n`);

    // Fetch SOL price immediately and every 5 minutes (CoinGecko, free)
    fetchSolPrice();
    setInterval(fetchSolPrice, 5 * 60 * 1000);

    // Refresh market data every 10 minutes (DexScreener, free)
    setInterval(() => refreshTokenMarketData(), 10 * 60 * 1000);

    if (HELIUS_ENABLED) {
        // ============================================
        // WEBHOOKS handle real-time trade ingestion.
        // Background scan runs every 6 hours as catchup.
        // ============================================

        // One-time backfill on first start if DB is sparse
        if (existing.count < 100) {
            console.log(`📥 DB has only ${existing.count} trades — running initial backfill...`);
            setTimeout(() => runBackgroundScan(), 2000);
        }

        // Background scan every 6 hours
        setInterval(() => runBackgroundScan(), 6 * 60 * 60 * 1000);

        console.log(`🔔 Webhook mode active — POST /webhook/helius receives trades`);
        console.log(`   Background scan every 6 hours as catchup.`);
    } else {
        console.log(`⏸️  Helius DISABLED — no scanning, no credits used.`);
        console.log(`   Webhook endpoint is ready but won't process without HELIUS_ENABLED=true`);
        console.log(`   The server will serve the frontend and API from cached DB data.\n`);
    }

    // Log estimated credit usage every hour
    setInterval(() => {
        if (heliusCreditEstimate > 0) {
            console.log(`📊 Estimated Helius credits used this session: ~${heliusCreditEstimate.toLocaleString()}`);
        }
    }, 60 * 60 * 1000);
});
