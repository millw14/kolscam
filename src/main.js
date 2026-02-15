import './style.css';
import { COL_DATA } from './data.js';

// --- Config ---
// Use relative URL in production (same origin), absolute in dev
const API_BASE = import.meta.env.DEV ? 'http://localhost:3001/api' : '/api';

// --- State ---
const APP_STATE = {
    currentPage: 'leaderboard',
    leaderboardPeriod: 'daily',
    solPrice: 0,
    tickerInterval: null,
    leaderboardRefreshInterval: null,
    tokensRefreshInterval: null,
    tradesRefreshInterval: null,
    profileKol: null,
    profileTab: 'main',
};

// --- DOM Elements ---
const navLinks = document.querySelectorAll('.nav-link');
const navLogo = document.querySelector('.nav-logo');
const pages = document.querySelectorAll('.page');
const leaderboardBody = document.getElementById('leaderboard-body');
const tradesGrid = document.getElementById('trades-grid');
const modal = document.getElementById('side-wallet-modal');
const closeModal = document.querySelector('#side-wallet-modal .close-modal');
const submitModal = document.getElementById('submit-modal');
const submitForm = document.getElementById('submit-wallet-form');
const closeSubmitModal = document.getElementById('close-submit-modal');
const btnSubmitWallet = document.getElementById('btn-submit-wallet');
const toggleBtns = document.querySelectorAll('.toggle-btn');
const landingTicker = document.getElementById('landing-ticker');
const solPriceDisplay = document.getElementById('sol-price-display');

// --- Navigation ---
function navigateTo(pageId) {
    APP_STATE.currentPage = pageId;
    navLinks.forEach(link => link.classList.toggle('active', link.dataset.page === pageId));
    pages.forEach(page => page.classList.toggle('hidden', page.id !== `page-${pageId}`));

    // Stop trades auto-refresh when leaving trades page
    if (APP_STATE.tradesRefreshInterval) {
        clearInterval(APP_STATE.tradesRefreshInterval);
        APP_STATE.tradesRefreshInterval = null;
    }

    if (pageId === 'trades') {
        renderTrades();
        APP_STATE.tradesRefreshInterval = setInterval(renderTrades, 8000);
    }
    if (pageId === 'leaderboard') fetchLeaderboard(APP_STATE.leaderboardPeriod);
    if (pageId === 'tokens') fetchTokens();
    if (pageId === 'profile' && APP_STATE.profileKol) renderProfile(APP_STATE.profileKol);
}

function openProfile(kolName) {
    const kol = COL_DATA.find(k => k.Name.toLowerCase() === kolName.toLowerCase());
    if (!kol) return;
    APP_STATE.profileKol = kol.Name;
    APP_STATE.profileTab = 'main';
    navigateTo('profile');
}

navLinks.forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigateTo(link.dataset.page); });
});
navLogo.addEventListener('click', (e) => { e.preventDefault(); navigateTo('landing'); });

// --- Helpers ---
function timeAgo(timestamp) {
    if (!timestamp) return 'just now';
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 0) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function timeAgoShort(timestamp) {
    if (!timestamp) return '0s';
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}hr`;
    return `${Math.floor(seconds / 86400)}d`;
}

function formatSol(amount) {
    if (amount >= 1000) return amount.toFixed(0);
    if (amount >= 100) return amount.toFixed(1);
    if (amount >= 1) return amount.toFixed(2);
    if (amount >= 0.01) return amount.toFixed(3);
    return amount.toFixed(4);
}

function formatTokenAmount(amount) {
    if (!amount || amount === 0) return '0';
    if (amount >= 1e9) return (amount / 1e9).toFixed(1) + 'b';
    if (amount >= 1e6) return (amount / 1e6).toFixed(1) + 'm';
    if (amount >= 1e3) return (amount / 1e3).toFixed(1) + 'k';
    if (amount >= 1) return amount.toFixed(0);
    return amount.toFixed(2);
}

function formatPrice(price) {
    if (!price || price === 0) return '';
    if (price >= 1) return '$' + price.toFixed(2);
    if (price >= 0.01) return '$' + price.toFixed(4);
    if (price >= 0.001) return '$' + price.toFixed(5);
    if (price >= 0.0001) return '$' + price.toFixed(6);
    // For very small prices like $0.0000057
    // Find first 2 significant digits after leading zeros
    const str = price.toFixed(20);
    const match = str.match(/^0\.(0*)([1-9]\d?)/);
    if (match) {
        return '$0.' + match[1] + match[2];
    }
    return '$' + price.toFixed(7);
}

function formatMcap(mcap) {
    if (!mcap || mcap === 0) return '';
    if (mcap >= 1e9) return (mcap / 1e9).toFixed(1) + 'b';
    if (mcap >= 1e6) return (mcap / 1e6).toFixed(1) + 'm';
    if (mcap >= 1e3) return (mcap / 1e3).toFixed(1) + 'k';
    return mcap.toFixed(0);
}

function formatUsd(amount) {
    if (Math.abs(amount) >= 1e6) return (amount / 1e6).toFixed(1) + 'M';
    if (Math.abs(amount) >= 1e3) return (amount / 1e3).toFixed(1) + 'K';
    return amount.toFixed(1);
}

async function apiFetch(endpoint) {
    try {
        const res = await fetch(`${API_BASE}${endpoint}`);
        if (!res.ok) throw new Error(`${res.status}`);
        return await res.json();
    } catch (err) {
        console.error(`API error: ${endpoint}`, err);
        return null;
    }
}

async function apiPost(endpoint, data) {
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await res.json();
    } catch (err) { return null; }
}

// --- SOL Price ---
async function updateSolPrice() {
    const data = await apiFetch('/sol-price');
    if (data?.price) {
        APP_STATE.solPrice = data.price;
        solPriceDisplay.textContent = `$${data.price.toFixed(2)}`;
    }
}

// ============================
// LEADERBOARD (Kolscan-style)
// ============================

toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        toggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const text = btn.textContent.trim().toLowerCase();
        APP_STATE.leaderboardPeriod = text;
        fetchLeaderboard(text);
    });
});

async function fetchLeaderboard(period = 'daily') {
    leaderboardBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:40px; color:#888;">
        <i class="ri-loader-4-line" style="font-size:1.5rem; animation: spin 1s linear infinite;"></i>
        <div style="margin-top:8px;">Loading ${period} leaderboard...</div>
    </td></tr>`;

    const data = await apiFetch(`/leaderboard?period=${period}`);

    if (data?.solPrice) {
        APP_STATE.solPrice = data.solPrice;
        solPriceDisplay.textContent = `$${data.solPrice.toFixed(2)}`;
    }

    if (!data || !data.leaderboard || data.leaderboard.length === 0) {
        const status = await apiFetch('/scanner/status');
        leaderboardBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:40px; color:#888;">
            <i class="ri-radar-line" style="font-size:1.5rem; animation: spin 3s linear infinite;"></i>
            <div style="margin-top:8px;">Indexing KOL wallets...</div>
            <div style="font-size:0.75rem; margin-top:4px; color:#555;">
                ${status ? `${status.totalTrades} trades from ${status.totalKols} KOLs (${status.phase === 'scanning' ? status.progress : 'refreshing...'})` : 'Starting up...'}
            </div>
        </td></tr>`;
        setTimeout(() => fetchLeaderboard(period), 5000);
        return;
    }

    renderLeaderboard(data.leaderboard, data.meta);
}

function renderLeaderboard(leaderboard, meta) {
    leaderboardBody.innerHTML = '';

    leaderboard.forEach((entry, index) => {
        const tr = document.createElement('tr');

        // Rank styling
        let rankHtml = `<span class="rank-text">${entry.rank}</span>`;
        let rowClass = 'row-normal';
        if (index === 0) { rankHtml = `<i class="ri-trophy-fill rank-icon rank-gold"></i>`; rowClass = 'row-gold'; }
        else if (index === 1) { rankHtml = `<i class="ri-medal-fill rank-icon rank-silver"></i>`; rowClass = 'row-silver'; }
        else if (index === 2) { rankHtml = `<i class="ri-medal-fill rank-icon rank-bronze"></i>`; rowClass = 'row-bronze'; }
        tr.className = rowClass;

        // Social icon
        let socialIcon = '';
        if (entry.twitter) {
            socialIcon = `<a href="${entry.twitter}" target="_blank" class="social-link"><i class="ri-twitter-x-fill"></i></a>`;
        }

        // PnL formatting
        const pnlClass = entry.pnl >= 0 ? 'buy' : 'sell';
        const pnlSign = entry.pnl >= 0 ? '+' : '';
        const pnlUsd = formatUsd(Math.abs(entry.pnlUsd || entry.pnl * APP_STATE.solPrice));
        const shortWallet = entry.wallet.substring(0, 6);

        // Buy/Sell counts - Kolscan style
        const buyCount = entry.buyCount || 0;
        const sellCount = entry.sellCount || 0;

        tr.innerHTML = `
          <td class="rank-cell">${rankHtml}</td>
          <td>
            <div class="trader-info">
              <img src="${entry.avatar}" class="kol-avatar" alt="${entry.name}" loading="lazy" onerror="this.src='/logo.png'" />
              <div class="trader-details">
                <div class="trader-name-row">
                    <span class="trader-name">${entry.name}</span>
                    ${socialIcon}
                    <span class="wallet-inline">${shortWallet}</span>
                </div>
              </div>
            </div>
          </td>
          <td class="trades-cell">
            <span class="count-buy">${buyCount}</span><span class="count-separator">/</span><span class="count-sell">${sellCount}</span>
          </td>
          <td class="${pnlClass} pnl-cell">${pnlSign}${formatSol(Math.abs(entry.pnl))} Sol <span class="pnl-usd">($${pnlUsd})</span></td>
        `;

        tr.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            openProfile(entry.name);
        });

        leaderboardBody.appendChild(tr);
    });

    // Scanner status footer
    if (meta) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="4" style="text-align:center; padding:10px; color:#444; font-size:0.7rem;">
            ${meta.totalTrades} trades from ${meta.totalKols} KOLs
            ${meta.scannerPhase === 'scanning' ? ` • Scanning: ${meta.scanProgress}` : ' • Live'}
        </td>`;
        leaderboardBody.appendChild(tr);
    }
}

// ============================
// TRADES PAGE (Kolscan-style feed)
// ============================

async function renderTrades() {
    tradesGrid.innerHTML = `<div style="text-align:center; color:#888; padding:40px; grid-column:1/-1;">
        <i class="ri-loader-4-line" style="font-size:2rem; animation: spin 1s linear infinite;"></i>
        <p style="margin-top:12px;">Loading trades...</p>
    </div>`;

    const data = await apiFetch('/trades/feed?limit=40');
    tradesGrid.innerHTML = '';

    if (!data || !data.trades || data.trades.length === 0) {
        tradesGrid.innerHTML = `<div style="text-align:center; color:#888; padding:40px; grid-column:1/-1;">
            <i class="ri-radar-line" style="font-size:2rem;"></i>
            <p style="margin-top:12px;">Scanner indexing...</p>
        </div>`;
        return;
    }

    if (data.solPrice) APP_STATE.solPrice = data.solPrice;

    data.trades.forEach(trade => {
        const card = document.createElement('div');
        card.className = 'trade-card';
        const actionClass = trade.action.toLowerCase();
        const actionVerb = trade.action === 'Buy' ? 'bought' : 'sold';

        // Token amount display
        const tokenAmtStr = trade.tokenAmount ? `(${formatTokenAmount(trade.tokenAmount)})` : '';

        // Price per token
        let priceStr = '';
        if (trade.tokenAmount > 0 && trade.amountSol > 0 && APP_STATE.solPrice > 0) {
            const pricePerToken = (trade.amountSol * APP_STATE.solPrice) / trade.tokenAmount;
            priceStr = `at ${formatPrice(pricePerToken)}`;
        }

        // Token image
        const tokenImg = trade.tokenImage
            ? `<img src="${trade.tokenImage}" class="token-img-small" onerror="this.style.display='none'" />`
            : '';

        // Padre.gg link
        const tokenLink = trade.tokenMint
            ? `<a href="https://trade.padre.gg/trade/solana/${trade.tokenMint}" target="_blank" class="trade-token token-link">${trade.tokenSymbol}</a>`
            : `<span class="trade-token">${trade.tokenSymbol}</span>`;

        const sideTag = trade.isSideWallet ? '<img src="/sidewallet.png" class="side-badge" title="Bundle wallet" />' : '';
        if (trade.isSideWallet) card.classList.add('bundle-trade');

        card.innerHTML = `
      <div class="trade-header">
        <img src="${trade.kolAvatar || '/logo.png'}" class="trade-avatar" alt="${trade.kolName}" onerror="this.src='/logo.png'" />
        <div class="trade-content">
          <span class="trade-name kol-link" data-kol="${trade.kolName}">${trade.kolName}${sideTag}</span>
          <span class="trade-verb ${actionClass}">${actionVerb}</span>
          <span class="trade-sol ${actionClass}">${formatSol(trade.amountSol)} sol</span>
          <span class="trade-token-amount">${tokenAmtStr}</span>
          <span>of</span>
          ${tokenImg}
          ${tokenLink}
          <span class="trade-price">${priceStr}</span>
        </div>
        <div class="trade-time">${timeAgo(trade.timestamp)}</div>
      </div>
    `;
        tradesGrid.appendChild(card);
    });
}

// ============================
// TOKENS PAGE (Kolscan-style: 3 columns)
// ============================

async function fetchTokens() {
    const containers = ['tokens-lowcaps', 'tokens-midcaps', 'tokens-highcaps'];
    containers.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<div class="token-loading"><i class="ri-loader-4-line" style="animation: spin 1s linear infinite;"></i> Loading...</div>`;
    });

    const data = await apiFetch('/tokens');
    if (!data) {
        containers.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<div class="token-loading">No data yet. Scanner is indexing...</div>`;
        });
        return;
    }

    if (data.solPrice) APP_STATE.solPrice = data.solPrice;

    renderTokenColumn('tokens-lowcaps', data.lowCaps || []);
    renderTokenColumn('tokens-midcaps', data.midCaps || []);
    renderTokenColumn('tokens-highcaps', data.highCaps || []);
}

function renderTokenColumn(containerId, tokens) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (tokens.length === 0) {
        container.innerHTML = `<div class="token-loading" style="color:#555;">No tokens yet</div>`;
        return;
    }

    tokens.forEach(token => {
        const card = document.createElement('div');
        card.className = 'token-card';

        const changeClass = token.priceChange >= 0 ? 'positive' : 'negative';
        const changeSign = token.priceChange >= 0 ? '+' : '';
        const mcapStr = token.mcap ? formatMcap(token.mcap) : '?';

        // Token image
        const tokenImg = token.image
            ? `<img src="${token.image}" class="token-card-img" onerror="this.style.display='none'" />`
            : `<div class="token-card-img-placeholder">${(token.symbol || '?')[0]}</div>`;

        // KOL positions rows
        let positionsHtml = '';
        if (token.positions && token.positions.length > 0) {
            positionsHtml = token.positions.map(pos => {
                const boughtStr = `${formatSol(pos.boughtSol)} Sol`;
                const boughtTokenStr = `(${formatTokenAmount(pos.boughtTokens)})`;
                const soldStr = `${formatSol(pos.soldSol)} Sol`;
                const soldTokenStr = `(${formatTokenAmount(pos.soldTokens)})`;
                const timeStr = timeAgoShort(pos.lastTrade);

                return `
                    <div class="token-position-row">
                        <img src="${pos.kolAvatar || '/logo.png'}" class="token-pos-avatar" onerror="this.src='/logo.png'" />
                        <span class="pos-buy">${boughtStr} <span class="pos-tokens">${boughtTokenStr}</span></span>
                        <span class="pos-sell">${soldStr} <span class="pos-tokens">${soldTokenStr}</span></span>
                        <span class="pos-time">${timeStr}</span>
                    </div>
                `;
            }).join('');
        }

        // Padre.gg link for token name
        const tokenNameHtml = token.mint
            ? `<a href="https://trade.padre.gg/trade/solana/${token.mint}" target="_blank" class="token-card-name token-link">${token.name || token.symbol}</a>`
            : `<span class="token-card-name">${token.name || token.symbol}</span>`;

        card.innerHTML = `
            <div class="token-card-header">
                <div class="token-card-info">
                    ${tokenImg}
                    <div class="token-card-meta">
                        ${tokenNameHtml}
                        <span class="token-card-mcap">MC ${mcapStr}</span>
                    </div>
                </div>
                <span class="token-card-change ${changeClass}">${changeSign}${token.priceChange?.toFixed(1) || 0}%</span>
            </div>
            <div class="token-positions">
                ${positionsHtml || '<div class="token-loading" style="font-size:0.75rem;">No positions</div>'}
            </div>
        `;

        container.appendChild(card);
    });
}

// ============================
// PROFILE PAGE
// ============================

async function renderProfile(kolName) {
    const kol = COL_DATA.find(k => k.Name === kolName);
    if (!kol) return;

    const profileHeader = document.getElementById('profile-header');
    const profileStats = document.getElementById('profile-stats');
    const profileWallets = document.getElementById('profile-wallets');
    const profileTrades = document.getElementById('profile-trades');

    // Back button
    const backBtn = document.getElementById('profile-back-btn');
    backBtn.onclick = (e) => { e.preventDefault(); navigateTo('leaderboard'); };

    const shortWallet = kol['Wallet Address'].substring(0, 8) + '...' + kol['Wallet Address'].slice(-6);

    // Header
    profileHeader.innerHTML = `
        <img src="${kol.Avatar || '/logo.png'}" class="profile-avatar" alt="${kol.Name}" onerror="this.src='/logo.png'" />
        <div class="profile-info">
            <div class="profile-name">
                ${kol.Name}
                ${kol['Twitter Handle'] ? `<a href="${kol['Twitter Handle']}" target="_blank" class="social-link"><i class="ri-twitter-x-fill" style="font-size:1.1rem;"></i></a>` : ''}
            </div>
            <div class="profile-wallet">
                <span>${shortWallet}</span>
                <i class="ri-file-copy-line copy-icon" data-copy="${kol['Wallet Address']}"></i>
            </div>
        </div>
    `;

    // Stats - fetch from leaderboard
    profileStats.innerHTML = `<div class="profile-empty"><i class="ri-loader-4-line" style="animation: spin 1s linear infinite;"></i></div>`;

    const lbData = await apiFetch(`/leaderboard?period=${APP_STATE.leaderboardPeriod}`);
    let entry = null;
    if (lbData?.leaderboard) {
        entry = lbData.leaderboard.find(e => e.wallet === kol['Wallet Address']);
    }

    if (entry) {
        const pnlClass = entry.pnl >= 0 ? 'positive' : 'negative';
        const pnlSign = entry.pnl >= 0 ? '+' : '';
        const pnlUsd = formatUsd(Math.abs(entry.pnlUsd || entry.pnl * APP_STATE.solPrice));

        profileStats.innerHTML = `
            <div class="profile-stat">
                <span class="profile-stat-value positive">${entry.buyCount || 0}</span>
                <span class="profile-stat-label">Buys</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-value negative">${entry.sellCount || 0}</span>
                <span class="profile-stat-label">Sells</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-value ${pnlClass}">${pnlSign}${formatSol(Math.abs(entry.pnl))} Sol</span>
                <span class="profile-stat-label">PnL</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-value ${pnlClass}">$${pnlUsd}</span>
                <span class="profile-stat-label">USD</span>
            </div>
        `;
    } else {
        profileStats.innerHTML = `
            <div class="profile-stat">
                <span class="profile-stat-value">--</span>
                <span class="profile-stat-label">Buys</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-value">--</span>
                <span class="profile-stat-label">Sells</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-value">--</span>
                <span class="profile-stat-label">PnL</span>
            </div>
        `;
    }

    // Wallets section
    const sideWallets = (kol['Side Wallets'] || []).filter(
        sw => sw && sw.length > 10 && sw !== kol['Wallet Address']
    );

    let walletsHtml = `<div class="wallets-title">Wallets</div>`;
    walletsHtml += `
        <div class="wallet-row">
            <div class="wallet-row-left">
                <i class="ri-wallet-3-line wallet-main-icon"></i>
                <span>${kol['Wallet Address'].substring(0, 12)}...${kol['Wallet Address'].slice(-8)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
                <span class="wallet-tag main">Main</span>
                <i class="ri-file-copy-line copy-icon" data-copy="${kol['Wallet Address']}" style="cursor:pointer;color:#666;font-size:0.85rem;"></i>
            </div>
        </div>
    `;

    sideWallets.forEach(sw => {
        walletsHtml += `
            <div class="wallet-row bundle-wallet-row">
                <div class="wallet-row-left">
                    <img src="/sidewallet.png" class="wallet-side-icon" />
                    <span>${sw.substring(0, 12)}...${sw.slice(-8)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="wallet-tag bundle">Bundle</span>
                    <i class="ri-file-copy-line copy-icon" data-copy="${sw}" style="cursor:pointer;color:#666;font-size:0.85rem;"></i>
                </div>
            </div>
        `;
    });

    if (sideWallets.length === 0) {
        walletsHtml += `<div style="color:#555;font-size:0.8rem;padding:8px 12px;">No bundle wallets tracked</div>`;
    }

    profileWallets.innerHTML = walletsHtml;

    // Tab handlers
    const tabs = document.querySelectorAll('.profile-tab');
    tabs.forEach(tab => {
        tab.onclick = () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            APP_STATE.profileTab = tab.dataset.tab;
            if (tab.dataset.tab === 'main') {
                loadMainWalletTrades(kol);
            } else {
                loadBundleTrades(kol);
            }
        };
    });

    // Load main wallet trades by default
    loadMainWalletTrades(kol);
}

async function loadMainWalletTrades(kol) {
    const profileTrades = document.getElementById('profile-trades');
    profileTrades.innerHTML = `<div class="profile-empty"><i class="ri-loader-4-line" style="animation: spin 1s linear infinite;"></i> Loading trades...</div>`;

    const data = await apiFetch(`/trades/${kol['Wallet Address']}?limit=50`);

    if (!data || !data.trades || data.trades.length === 0) {
        profileTrades.innerHTML = `<div class="profile-empty">No trades recorded yet</div>`;
        return;
    }

    profileTrades.innerHTML = '';
    data.trades.forEach(trade => {
        const row = document.createElement('div');
        row.className = 'profile-trade-row';
        const actionClass = trade.action.toLowerCase();

        row.innerHTML = `
            <span class="profile-trade-action ${actionClass}">${trade.action}</span>
            <span class="profile-trade-token">${trade.tokenSymbol}</span>
            <span class="profile-trade-amount">${formatTokenAmount(trade.tokenAmount)}</span>
            <span class="profile-trade-sol">${formatSol(trade.amountSol)} Sol</span>
            <span class="profile-trade-time">${timeAgo(trade.timestamp)}</span>
        `;
        profileTrades.appendChild(row);
    });
}

async function loadBundleTrades(kol) {
    const profileTrades = document.getElementById('profile-trades');
    profileTrades.innerHTML = `<div class="profile-empty"><i class="ri-loader-4-line" style="animation: spin 1s linear infinite;"></i> Loading bundle trades...</div>`;

    const data = await apiFetch(`/kol/${encodeURIComponent(kol.Name)}/sides`);

    if (!data || !data.trades || data.trades.length === 0) {
        profileTrades.innerHTML = `<div class="profile-empty">No bundle wallet trades recorded yet</div>`;
        return;
    }

    profileTrades.innerHTML = '';
    data.trades.forEach(trade => {
        const row = document.createElement('div');
        row.className = 'profile-trade-row bundle-trade';
        const actionClass = trade.action.toLowerCase();
        const shortWallet = trade.wallet ? trade.wallet.substring(0, 6) + '...' : '';

        row.innerHTML = `
            <img src="/sidewallet.png" class="bundle-trade-ghost" title="Bundle wallet" />
            <span class="profile-trade-action ${actionClass}">${trade.action}</span>
            <span class="profile-trade-token">${trade.tokenSymbol}</span>
            <span class="profile-trade-amount">${formatTokenAmount(trade.tokenAmount)}</span>
            <span class="profile-trade-sol">${formatSol(trade.amountSol)} Sol</span>
            <span class="profile-trade-wallet-tag" title="${trade.wallet || ''}">${shortWallet}</span>
            <span class="profile-trade-time">${timeAgo(trade.timestamp)}</span>
        `;
        profileTrades.appendChild(row);
    });
}

// ============================
// SUBMIT SIDE WALLET MODAL
// ============================

// Populate KOL dropdown from COL_DATA
function populateKolDropdown() {
    const select = document.getElementById('submit-kol-select');
    if (!select) return;
    const sorted = [...COL_DATA].sort((a, b) => a.Name.localeCompare(b.Name));
    sorted.forEach(kol => {
        const opt = document.createElement('option');
        opt.value = kol.Name;
        opt.textContent = kol.Name;
        select.insertBefore(opt, select.lastElementChild);
    });
}
populateKolDropdown();

// Toggle new KOL fields
const kolSelect = document.getElementById('submit-kol-select');
const newKolFields = document.getElementById('new-kol-fields');
if (kolSelect) {
    kolSelect.addEventListener('change', () => {
        if (kolSelect.value === '__new__') {
            newKolFields.classList.remove('hidden');
        } else {
            newKolFields.classList.add('hidden');
        }
    });
}

// Open modal
if (btnSubmitWallet) {
    btnSubmitWallet.addEventListener('click', () => {
        submitModal.classList.remove('hidden');
    });
}

// Close modal
if (closeModal) closeModal.addEventListener('click', () => modal.classList.add('hidden'));
if (closeSubmitModal) closeSubmitModal.addEventListener('click', () => submitModal.classList.add('hidden'));
window.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
    if (e.target === submitModal) submitModal.classList.add('hidden');
});

// Submit form
if (submitForm) {
    submitForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const statusEl = document.getElementById('submit-status');
        const select = document.getElementById('submit-kol-select');
        const walletAddress = document.getElementById('submit-wallet-address').value.trim();
        const notes = document.getElementById('submit-notes').value.trim();

        let kolName = select.value;
        let twitter = '';
        let isNewKol = false;

        if (kolName === '__new__') {
            kolName = document.getElementById('submit-new-name').value.trim();
            twitter = document.getElementById('submit-new-twitter').value.trim();
            isNewKol = true;
            if (!kolName || kolName.length < 2) {
                statusEl.innerHTML = `<span class="submit-error">Enter the KOL's name</span>`;
                return;
            }
        }

        if (!kolName || kolName === '') {
            statusEl.innerHTML = `<span class="submit-error">Select a KOL</span>`;
            return;
        }

        if (!walletAddress || walletAddress.length < 32) {
            statusEl.innerHTML = `<span class="submit-error">Enter a valid Solana wallet address</span>`;
            return;
        }

        statusEl.innerHTML = `<span class="submit-pending"><i class="ri-loader-4-line" style="animation: spin 1s linear infinite;"></i> Submitting...</span>`;

        const result = await apiPost('/submit-side-wallet', { kolName, twitter, walletAddress, isNewKol, notes });

        if (result?.success) {
            statusEl.innerHTML = `<span class="submit-success"><i class="ri-check-line"></i> Submitted! We'll review it shortly.</span>`;
            submitForm.reset();
            newKolFields.classList.add('hidden');
            setTimeout(() => {
                submitModal.classList.add('hidden');
                statusEl.innerHTML = '';
            }, 2500);
        } else {
            statusEl.innerHTML = `<span class="submit-error"><i class="ri-error-warning-line"></i> ${result?.error || 'Failed to submit'}</span>`;
        }
    });
}

// ============================
// LANDING TICKER (Kolscan-style format)
// ============================

async function fetchTickerTrades() {
    const data = await apiFetch('/trades/feed?limit=15');

    if (data && data.trades && data.trades.length > 0) {
        if (data.solPrice) APP_STATE.solPrice = data.solPrice;

        landingTicker.innerHTML = '';
        data.trades.forEach(trade => {
            const div = document.createElement('div');
            div.className = 'ticker-item';

            const actionVerb = trade.action === 'Buy' ? 'bought' : 'sold';
            const actionClass = trade.action.toLowerCase();

            // Token amount
            const tokenAmtStr = trade.tokenAmount ? `(${formatTokenAmount(trade.tokenAmount)})` : '';

            // Price per token
            let priceStr = '';
            if (trade.tokenAmount > 0 && trade.amountSol > 0 && APP_STATE.solPrice > 0) {
                const pricePerToken = (trade.amountSol * APP_STATE.solPrice) / trade.tokenAmount;
                priceStr = `at <span class="ticker-price">${formatPrice(pricePerToken)}</span>`;
            }

            // Token image
            const tokenImg = trade.tokenImage
                ? `<img src="${trade.tokenImage}" class="ticker-token-img" onerror="this.style.display='none'" />`
                : '';

            // Padre.gg link
            const tokenLink = trade.tokenMint
                ? `<a href="https://trade.padre.gg/trade/solana/${trade.tokenMint}" target="_blank" class="ticker-token token-link">${trade.tokenSymbol}</a>`
                : `<span class="ticker-token">${trade.tokenSymbol}</span>`;

            const tickerSideTag = trade.isSideWallet ? '<img src="/sidewallet.png" class="side-badge" title="Bundle wallet" />' : '';
            if (trade.isSideWallet) div.classList.add('bundle-trade');

            div.innerHTML = `
                <img src="${trade.kolAvatar || '/logo.png'}" class="ticker-kol-img" onerror="this.src='/logo.png'" />
                <span class="ticker-name kol-link" data-kol="${trade.kolName}">${trade.kolName}${tickerSideTag}</span>
                <span class="ticker-verb">${actionVerb}</span>
                <span class="ticker-sol ${actionClass}">${formatSol(trade.amountSol)} sol</span>
                <span class="ticker-token-amt">${tokenAmtStr}</span>
                <span>of</span>
                ${tokenImg}
                ${tokenLink}
                <span class="ticker-at">${priceStr}</span>
                <span class="ticker-time">${timeAgo(trade.timestamp)}</span>
            `;
            landingTicker.appendChild(div);
        });
    } else if (landingTicker.children.length === 0) {
        landingTicker.innerHTML = `<div class="ticker-item" style="justify-content:center; color:#888;">
            <i class="ri-radar-line" style="animation: spin 3s linear infinite;"></i>
            <span>Indexing KOL wallets... trades appear shortly</span>
        </div>`;
    }
}

// ============================
// WALLET SEARCH
// ============================

const heroSearchInput = document.querySelector('.hero-search input');
const heroSearchBtn = document.querySelector('.hero-search .search-btn');

async function searchWallet() {
    const query = heroSearchInput.value.trim();
    if (!query || query.length < 32) { alert('Enter a valid Solana wallet address'); return; }

    landingTicker.innerHTML = `<div class="ticker-item" style="justify-content:center; color:#888;">
        <i class="ri-loader-4-line" style="animation: spin 1s linear infinite;"></i>
        <span>Looking up wallet...</span>
    </div>`;

    const data = await apiFetch(`/trades/${query}?limit=15`);

    if (!data || !data.trades || data.trades.length === 0) {
        landingTicker.innerHTML = `<div class="ticker-item" style="justify-content:center; color:#888;">
            <i class="ri-error-warning-line"></i><span>No transactions found</span>
        </div>`;
        return;
    }

    if (data.solPrice) APP_STATE.solPrice = data.solPrice;
    landingTicker.innerHTML = '';

    if (data.kol) {
        const infoDiv = document.createElement('div');
        infoDiv.className = 'ticker-item';
        infoDiv.style.cssText = 'background:rgba(255,42,42,0.08); border-color:rgba(255,42,42,0.2);';
        infoDiv.innerHTML = `
            <img src="${data.kol.avatar || '/logo.png'}" class="ticker-kol-img" />
            <span style="color:var(--accent-red); font-weight:700;">Known KOL: ${data.kol.name}</span>
        `;
        landingTicker.appendChild(infoDiv);
    }

    data.trades.forEach(trade => {
        const div = document.createElement('div');
        div.className = 'ticker-item';
        const actionVerb = trade.action === 'Buy' ? 'bought' : 'sold';
        const tokenAmtStr = trade.tokenAmount ? `(${formatTokenAmount(trade.tokenAmount)})` : '';

        div.innerHTML = `
            <img src="${data.kol?.avatar || '/logo.png'}" class="ticker-kol-img" onerror="this.src='/logo.png'" />
            <span class="ticker-name">${trade.kolName}</span>
            <span class="ticker-verb">${actionVerb}</span>
            <span class="ticker-sol ${trade.action.toLowerCase()}">${formatSol(trade.amountSol)} sol</span>
            <span class="ticker-token-amt">${tokenAmtStr}</span>
            <span>of</span>
            <span class="ticker-token">${trade.tokenSymbol}</span>
            <span class="ticker-time">${timeAgo(trade.timestamp)}</span>
        `;
        landingTicker.appendChild(div);
    });
}

if (heroSearchBtn) heroSearchBtn.addEventListener('click', searchWallet);
if (heroSearchInput) heroSearchInput.addEventListener('keypress', e => { if (e.key === 'Enter') searchWallet(); });

// ============================
// COPY
// ============================

document.addEventListener('click', (e) => {
    // Copy wallet
    const icon = e.target.closest('.copy-icon');
    if (icon?.dataset.copy) {
        navigator.clipboard.writeText(icon.dataset.copy).then(() => {
            icon.classList.replace('ri-file-copy-line', 'ri-check-line');
            icon.style.color = 'var(--accent-green)';
            setTimeout(() => { icon.classList.replace('ri-check-line', 'ri-file-copy-line'); icon.style.color = ''; }, 1500);
        });
        return;
    }

    // Clickable KOL names -> profile
    const kolLink = e.target.closest('.kol-link');
    if (kolLink?.dataset.kol) {
        e.preventDefault();
        openProfile(kolLink.dataset.kol);
    }
});

// ============================
// INIT
// ============================

const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);

// Start on landing
navigateTo('landing');

// Fetch SOL price
updateSolPrice();

// Live ticker: poll every 5 seconds for near real-time feel
fetchTickerTrades();
APP_STATE.tickerInterval = setInterval(fetchTickerTrades, 5000);

// Leaderboard: auto-refresh every 30 seconds
APP_STATE.leaderboardRefreshInterval = setInterval(() => {
    if (APP_STATE.currentPage === 'leaderboard') {
        fetchLeaderboard(APP_STATE.leaderboardPeriod);
    }
}, 30000);

// Tokens: auto-refresh every 60 seconds
APP_STATE.tokensRefreshInterval = setInterval(() => {
    if (APP_STATE.currentPage === 'tokens') {
        fetchTokens();
    }
}, 60000);

// SOL price: refresh every 2 min
setInterval(updateSolPrice, 2 * 60 * 1000);
