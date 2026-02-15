import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use DATABASE_PATH env var for Railway volume, fallback to local
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'kolscam.db');
const db = new Database(DB_PATH);
console.log(`📂 Database: ${DB_PATH}`);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Create base tables (original schema for backwards compat)
db.exec(`
  CREATE TABLE IF NOT EXISTS submitted_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS token_cache (
    mint TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    image TEXT,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kol_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    kol_name TEXT NOT NULL,
    kol_avatar TEXT DEFAULT '',
    action TEXT NOT NULL,
    token_symbol TEXT NOT NULL,
    amount_sol REAL DEFAULT 0,
    signature TEXT UNIQUE,
    tx_timestamp INTEGER NOT NULL,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_kol_trades_wallet ON kol_trades(wallet);
  CREATE INDEX IF NOT EXISTS idx_kol_trades_timestamp ON kol_trades(tx_timestamp);
  CREATE INDEX IF NOT EXISTS idx_kol_trades_signature ON kol_trades(signature);
`);

// --- Migrations: add new columns to existing databases ---
try { db.exec('ALTER TABLE kol_trades ADD COLUMN token_mint TEXT DEFAULT ""'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE kol_trades ADD COLUMN token_amount REAL DEFAULT 0'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE token_cache ADD COLUMN mcap REAL DEFAULT 0'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE token_cache ADD COLUMN price_usd REAL DEFAULT 0'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE token_cache ADD COLUMN price_change_24h REAL DEFAULT 0'); } catch(e) { /* already exists */ }

// --- Side wallet submissions table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS side_wallet_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kol_name TEXT NOT NULL,
    twitter TEXT DEFAULT '',
    wallet_address TEXT NOT NULL,
    is_new_kol INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Create indexes that depend on new columns (after migration) ---
try { db.exec('CREATE INDEX IF NOT EXISTS idx_kol_trades_token_mint ON kol_trades(token_mint)'); } catch(e) { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_kol_trades_action ON kol_trades(action)'); } catch(e) { /* */ }

// --- Submitted Wallets ---
const insertWallet = db.prepare(`
  INSERT OR IGNORE INTO submitted_wallets (address, label, notes) VALUES (?, ?, ?)
`);

const getAllWallets = db.prepare(`
  SELECT * FROM submitted_wallets ORDER BY submitted_at DESC
`);

const getWalletByAddress = db.prepare(`
  SELECT * FROM submitted_wallets WHERE address = ?
`);

// --- Token Cache ---
const getCachedToken = db.prepare(`
  SELECT * FROM token_cache WHERE mint = ?
`);

const upsertTokenCache = db.prepare(`
  INSERT OR REPLACE INTO token_cache (mint, name, symbol, image, cached_at) 
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

const upsertTokenMarketData = db.prepare(`
  INSERT INTO token_cache (mint, name, symbol, image, mcap, price_usd, price_change_24h, cached_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(mint) DO UPDATE SET
    mcap = excluded.mcap,
    price_usd = excluded.price_usd,
    price_change_24h = excluded.price_change_24h,
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE token_cache.name END,
    symbol = CASE WHEN excluded.symbol != '' THEN excluded.symbol ELSE token_cache.symbol END,
    image = CASE WHEN excluded.image != '' THEN excluded.image ELSE token_cache.image END,
    cached_at = CURRENT_TIMESTAMP
`);

// --- KOL Trades ---
const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO kol_trades (wallet, kol_name, kol_avatar, action, token_symbol, amount_sol, signature, tx_timestamp, token_mint, token_amount)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Diverse feed: max 2 trades per KOL, so no single KOL floods the feed
const getRecentTrades = db.prepare(`
  SELECT sub.*, tc.image as token_image, tc.price_usd as token_price
  FROM (
    SELECT kt.*, 
      ROW_NUMBER() OVER (PARTITION BY kt.wallet ORDER BY kt.tx_timestamp DESC) as rn
    FROM kol_trades kt
    WHERE kt.action IN ('Buy', 'Sell')
  ) sub
  LEFT JOIN token_cache tc ON sub.token_mint = tc.mint
  WHERE sub.rn <= 2
  ORDER BY sub.tx_timestamp DESC
  LIMIT ?
`);

// Raw recent trades (no diversity filter, excludes stablecoins/SOL)
const getRecentTradesRaw = db.prepare(`
  SELECT kt.*, tc.image as token_image, tc.price_usd as token_price
  FROM kol_trades kt
  LEFT JOIN token_cache tc ON kt.token_mint = tc.mint
  WHERE kt.action IN ('Buy', 'Sell')
    AND kt.token_symbol NOT IN ('SOL', 'WSOL', 'USDC', 'USDT', 'USDS', 'mSOL', 'jitoSOL', 'bSOL', 'stSOL', 'JitoSOL', 'WETH', 'WBTC', 'RAY', 'JLP', 'JTO', 'PYTH', 'JUP')
    AND kt.token_mint NOT IN ('So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
  ORDER BY kt.tx_timestamp DESC LIMIT ?
`);

const getTradesSince = db.prepare(`
  SELECT * FROM kol_trades WHERE tx_timestamp >= ? AND action IN ('Buy', 'Sell') ORDER BY tx_timestamp DESC LIMIT ?
`);

// Leaderboard: aggregate stats per KOL name (combines main + side wallets)
const getLeaderboardStats = db.prepare(`
  SELECT 
    kol_name,
    MAX(kol_avatar) as kol_avatar,
    MIN(wallet) as wallet,
    COUNT(*) as trade_count,
    SUM(CASE WHEN action = 'Buy' THEN 1 ELSE 0 END) as buy_count,
    SUM(CASE WHEN action = 'Sell' THEN 1 ELSE 0 END) as sell_count,
    SUM(CASE WHEN action = 'Buy' THEN -amount_sol ELSE 0 END) +
    SUM(CASE WHEN action = 'Sell' THEN amount_sol ELSE 0 END) as pnl,
    ROUND(
      CAST(SUM(CASE WHEN action = 'Sell' AND amount_sol > 0 THEN 1 ELSE 0 END) AS REAL) /
      NULLIF(COUNT(*), 0) * 100
    , 1) as win_rate
  FROM kol_trades 
  WHERE tx_timestamp >= ? AND action IN ('Buy', 'Sell')
  GROUP BY kol_name
  ORDER BY pnl DESC
  LIMIT ?
`);

// Get recently traded tokens (for Tokens page)
const getRecentTokens = db.prepare(`
  SELECT 
    token_mint,
    token_symbol,
    COUNT(*) as trade_count,
    COUNT(DISTINCT wallet) as kol_count,
    MAX(tx_timestamp) as last_trade
  FROM kol_trades
  WHERE action IN ('Buy', 'Sell') AND token_mint != '' AND token_mint IS NOT NULL
    AND tx_timestamp >= ?
  GROUP BY token_mint
  HAVING trade_count >= 2
  ORDER BY last_trade DESC
  LIMIT ?
`);

// Get KOL positions for a specific token (aggregated buys/sells per KOL)
const getTokenKolPositions = db.prepare(`
  SELECT 
    wallet,
    kol_name,
    kol_avatar,
    SUM(CASE WHEN action = 'Buy' THEN amount_sol ELSE 0 END) as total_bought_sol,
    SUM(CASE WHEN action = 'Buy' THEN token_amount ELSE 0 END) as total_bought_tokens,
    SUM(CASE WHEN action = 'Sell' THEN amount_sol ELSE 0 END) as total_sold_sol,
    SUM(CASE WHEN action = 'Sell' THEN token_amount ELSE 0 END) as total_sold_tokens,
    MAX(tx_timestamp) as last_trade
  FROM kol_trades
  WHERE token_mint = ? AND action IN ('Buy', 'Sell')
  GROUP BY wallet
  ORDER BY last_trade DESC
  LIMIT ?
`);

// Count total trades in DB
const getTradeCount = db.prepare(`SELECT COUNT(*) as count FROM kol_trades WHERE action IN ('Buy', 'Sell')`);

// Count unique KOLs scanned
const getScannedKolCount = db.prepare(`SELECT COUNT(DISTINCT wallet) as count FROM kol_trades`);

// --- Side Wallet Submissions ---
const insertSideWalletSubmission = db.prepare(`
  INSERT INTO side_wallet_submissions (kol_name, twitter, wallet_address, is_new_kol, notes)
  VALUES (?, ?, ?, ?, ?)
`);

const getAllSubmissions = db.prepare(`
  SELECT * FROM side_wallet_submissions ORDER BY submitted_at DESC LIMIT ?
`);

const getSubmissionCount = db.prepare(`
  SELECT COUNT(*) as count FROM side_wallet_submissions
`);

export {
  db,
  insertWallet,
  getAllWallets,
  getWalletByAddress,
  getCachedToken,
  upsertTokenCache,
  upsertTokenMarketData,
  insertTrade,
  getRecentTrades,
  getRecentTradesRaw,
  getTradesSince,
  getLeaderboardStats,
  getRecentTokens,
  getTokenKolPositions,
  getTradeCount,
  getScannedKolCount,
  insertSideWalletSubmission,
  getAllSubmissions,
  getSubmissionCount
};
