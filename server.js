require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3456;

// ─── Constants (ported verbatim from lenny_ascii_raffle_dashboard_v3_101.html) ──
const BASE = 'https://mainnet-public.mirrornode.hedera.com';
const MIRROR = BASE + '/api/v1';
const DVINCI = 'https://locker.davincigraph.io/api/v3';

const TOKEN_ID   = '0.0.10072399'; // ASCII NFT collection
const LP_TOKEN_ID = '0.0.9480975'; // HBAR-LENNY LP token
const LP_SENDER   = '0.0.627512';  // LP airdrop wallet
const LENNY_TOKEN = '0.0.9445148'; // $LENNY (6 decimals)
const LENNY_BOT   = '0.0.1997335'; // Harvey staking bot
const WHBAR_TOKEN = '0.0.1456986';
const POOL_CONTRACT = '0.0.9480974'; // HBAR-LENNY pool contract

const LENNY_DECIMALS = 6;
const LENNY_PER_TICKET = 333333;

// Season 1 staking window: May 8 – Jun 9, 2026 (rewards FROM Harvey)
const STAKING_S1_START = 1778198400;
const STAKING_S1_END   = 1781049600;
const STAKING_EXCLUDED = new Set(['0.0.9445148','0.0.1456986','0.0.10072399','0.0.9480975','0.0.9480974','0.0.10306061','0.0.9482093','0.0.8215492','0.0.8215507','0.0.9516021','0.0.9471520','0.0.9589676','0.0.9602834','0.0.9586556','0.0.9454420','0.0.9445170']);

const TIERS = {
  peach:  { min: 667, max: 769, pts: 4, label: '🍑' },
  gold:   { min: 1,   max: 111, pts: 3, label: 'Gold' },
  nickel: { min: 112, max: 333, pts: 2, label: 'Nickel' },
  penny:  { min: 334, max: 666, pts: 1, label: 'Penny' },
};

// Smart-contract / platform wallets — get 0 raffle tickets
const RAFFLE_CONTRACT_WALLETS = new Set([
  '0.0.8215492','0.0.8215507','0.0.9480974','0.0.10306061','0.0.9589676',
  '0.0.9484867','0.0.9482093','0.0.9516021','0.0.9471520','0.0.9602834',
  '0.0.9586556','0.0.9454420','0.0.9445170','0.0.9480975','0.0.10072399',
  '0.0.1997335',
]);

// LP airdrop rounds (exact date windows)
const LP_ROUNDS = [
  { gt: 1762992000, lt: 1763164800, label: 'Round 1 · Nov 13, 2025' },
  { gt: 1763596800, lt: 1763769600, label: 'Round 2 · Nov 20, 2025' },
  { gt: 1764979200, lt: 1765152000, label: 'Round 3 · Dec 6, 2025' },
  { gt: 1773014400, lt: 1773187200, label: 'Round 4 · Mar 9, 2026' },
  { gt: 1776556800, lt: 1776816000, label: 'Round 5 · Apr 20, 2026' },
];

// 11 known SaucerSwap LENNY pools
const LENNY_POOLS = [
  { title: 'HBAR - LENNY',     lpTokenId: '0.0.9480975',  poolId: 'saucerswap-1-0.0.1456986-0.0.9445148' },
  { title: 'BTC.ℏ - LENNY',    lpTokenId: '0.0.10016554', poolId: 'saucerswap-1-0.0.9370957-0.0.9445148' },
  { title: 'HBAR.ℏ - LENNY',   lpTokenId: '0.0.9516022',  poolId: 'saucerswap-1-0.0.9356476-0.0.9445148' },
  { title: 'LENNY - $CKNBLZ',  lpTokenId: '0.0.9604090',  poolId: 'saucerswap-1-0.0.9445148-0.0.9468085' },
  { title: 'BCH.ℏ - LENNY',    lpTokenId: '0.0.9602835',  poolId: 'saucerswap-1-0.0.9363903-0.0.9445148' },
  { title: 'DICK - LENNY',     lpTokenId: '0.0.9589677',  poolId: 'saucerswap-1-0.0.781589-0.0.9445148' },
  { title: 'XPH - LENNY',      lpTokenId: '0.0.9471521',  poolId: 'saucerswap-1-0.0.4351436-0.0.9445148' },
  { title: 'SAUCE - LENNY',    lpTokenId: '0.0.9484868',  poolId: 'saucerswap-1-0.0.731861-0.0.9445148' },
  { title: 'WETH[hts] - LENNY',lpTokenId: '0.0.9586557',  poolId: 'saucerswap-1-0.0.541564-0.0.9445148' },
  { title: 'CLXY - LENNY',     lpTokenId: '0.0.9445171',  poolId: 'saucerswap-1-0.0.859814-0.0.9445148' },
  { title: 'gib - LENNY',      lpTokenId: '0.0.9454421',  poolId: 'saucerswap-1-0.0.7893707-0.0.9445148' },
];

// SilkSuite DEX LP positions are minted as NFTs (not fungible LP tokens). Both LENNY-paired
// pools (SILK/lenny, HSUITE/lenny) live under one LP-NFT collection. Undocumented public API
// (open CORS), used read-only and wrapped defensively since it's a third-party dependency.
const SILK_LP_NFT_ID = '0.0.5471454';
const SILK_LENNY_POOL_WALLETS = new Set(['0.0.10306061', '0.0.9482093']); // SILK/lenny, HSUITE/lenny
const SILK_API_HOSTS = ['tomachi', 'houdini', 'topachi', 'permabull'].map(h => 'https://' + h + '.silksuite.app');

// ─── Cache ──────────────────────────────────────────────────────
const cache = {
  tickets: {},   // wallet -> full breakdown
  meta: { builtAt: 0, lennyUsd: null, hbarUsd: null, lpPriceUsd: null, totalWallets: 0 },
  building: false,
};

const CACHE_DIR = path.join(__dirname, '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
function writeDiskCache(name, data) {
  try { fs.writeFileSync(path.join(CACHE_DIR, `${name}.json`), JSON.stringify(data)); } catch {}
}
function readDiskCache(name) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${name}.json`), 'utf8')); } catch { return null; }
}

// ─── Fetch helpers ──────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, retries = 6) {
  const url = p.startsWith('http') ? p : MIRROR + p;
  for (let att = 0; att < retries; att++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status === 429 && att < retries - 1) {
      await sleep(Math.min(800 * Math.pow(2, att) + Math.random() * 400, 20000));
      continue;
    }
    throw new Error('HTTP ' + r.status);
  }
  throw new Error('retries exhausted');
}

// Paginate a Mirror-node list endpoint. `path` is relative to MIRROR (includes /api/v1 base).
async function fetchAll(pathRel, key, max = 5000) {
  let all = [], url = MIRROR + pathRel;
  while (url) {
    const d = await api(url);
    all = all.concat(d[key] || []);
    const next = d.links && d.links.next;
    url = next ? BASE + next : null;
    if (all.length >= max) break;
  }
  return all;
}

async function jget(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

// ─── Tier helpers ───────────────────────────────────────────────
function getTier(s) { for (const [k, t] of Object.entries(TIERS)) if (s >= t.min && s <= t.max) return k; return 'penny'; }
function calcNftTix(c) { return c.gold * 3 + c.nickel * 2 + c.penny * 1 + c.peach * 4; }
function lennyTickets(rawBal) { if (!rawBal || rawBal <= 0) return 0; return Math.floor((rawBal / Math.pow(10, LENNY_DECIMALS)) / LENNY_PER_TICKET); }

// ─── Pricing (ported) ───────────────────────────────────────────
async function computePrices(state) {
  let hbarUsd = null, lennyUsd = null, lpPriceUsd = null;
  // HBAR/USD — Coinbase & Kraken work from datacenter IPs (Render); CoinGecko/Binance
  // block cloud IPs so they're last-resort fallbacks only.
  const cb = await jget('https://api.coinbase.com/v2/prices/HBAR-USD/spot');
  hbarUsd = cb?.data?.amount ? parseFloat(cb.data.amount) : null;
  if (!hbarUsd) {
    const kr = await jget('https://api.kraken.com/0/public/Ticker?pair=HBARUSD');
    const krKey = kr?.result ? Object.keys(kr.result)[0] : null;
    hbarUsd = krKey ? parseFloat(kr.result[krKey].c[0]) : null;
  }
  if (!hbarUsd) {
    const cg = await jget('https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd');
    hbarUsd = cg?.['hedera-hashgraph']?.usd ?? null;
  }
  if (!hbarUsd) {
    const b = await jget('https://api.binance.com/api/v3/ticker/price?symbol=HBARUSDT');
    hbarUsd = b?.price ? parseFloat(b.price) : null;
  }
  // HBAR-LENNY LP price = (WHBAR_in_pool × HBAR_USD × 2) / LP_supply
  try {
    const lpInfo = await api('/tokens/' + LP_TOKEN_ID);
    const lpDec = parseInt(lpInfo.decimals ?? 8);
    const lpSupply = parseInt(lpInfo.total_supply || 0) / Math.pow(10, lpDec);
    const whbarBals = await api('/tokens/' + WHBAR_TOKEN + '/balances?account.id=' + POOL_CONTRACT + '&limit=1');
    const whbarEntry = (whbarBals.balances || []).find(b => b.account === POOL_CONTRACT);
    const whbarInPool = whbarEntry ? parseInt(whbarEntry.balance) / 1e8 : 0;
    if (hbarUsd && lpSupply > 0 && whbarInPool > 0) {
      lpPriceUsd = (whbarInPool * hbarUsd * 2) / lpSupply;
    }
  } catch (e) { console.warn('[price] LP price:', e.message); }
  // LENNY/USD from pool reserves
  try {
    const [wb, lb] = await Promise.all([
      api('/tokens/' + WHBAR_TOKEN + '/balances?account.id=' + POOL_CONTRACT + '&limit=1'),
      api('/tokens/' + LENNY_TOKEN + '/balances?account.id=' + POOL_CONTRACT + '&limit=1'),
    ]);
    const whbarRaw = (wb.balances || []).find(b => b.account === POOL_CONTRACT);
    const lennyRaw = (lb.balances || []).find(b => b.account === POOL_CONTRACT);
    if (hbarUsd && whbarRaw && lennyRaw && parseInt(lennyRaw.balance) > 0) {
      const whbarAmt = parseInt(whbarRaw.balance) / 1e8;
      const lennyAmt = parseInt(lennyRaw.balance) / 1e6;
      lennyUsd = (whbarAmt * hbarUsd) / lennyAmt;
    }
  } catch (e) { console.warn('[price] LENNY price:', e.message); }
  state.hbarUsd = hbarUsd;
  state.lennyUsd = lennyUsd;
  state.lpPriceUsd = lpPriceUsd;
  console.log(`[price] HBAR $${hbarUsd} | LENNY $${lennyUsd} | LP $${lpPriceUsd}`);
}

// ─── Loaders ────────────────────────────────────────────────────
async function loadNftHolders(state) {
  const nfts = await fetchAll(`/tokens/${TOKEN_ID}/nfts?limit=100&order=asc`, 'nfts', 100000);
  const map = {};
  nfts.filter(n => !n.deleted).forEach(n => {
    const a = n.account_id;
    if (!map[a]) map[a] = { gold: 0, nickel: 0, penny: 0, peach: 0 };
    map[a][getTier(parseInt(n.serial_number))]++;
  });
  state.nftCounts = map;
  console.log('[nfts]', nfts.length, 'NFTs,', Object.keys(map).length, 'holders');
}

async function loadLennyBalances(state) {
  const bals = await fetchAll('/tokens/' + LENNY_TOKEN + '/balances?limit=100&order=desc', 'balances', 100000);
  const map = {};
  bals.forEach(b => { map[b.account] = parseInt(b.balance || 0); });
  state.lennyBalances = map;
  console.log('[lenny] balances:', Object.keys(map).length);
}

async function loadStaking(state) {
  const stakingByWallet = {};
  const url = `/transactions?account.id=${LENNY_BOT}&transactiontype=CRYPTOTRANSFER&limit=100&order=asc&timestamp=gte:${STAKING_S1_START}&timestamp=lt:${STAKING_S1_END}`;
  const txns = await fetchAll(url, 'transactions', 10000);
  txns.forEach(tx => {
    const tt = tx.token_transfers || [];
    const out = tt.find(t => t.token_id === LENNY_TOKEN && t.account === LENNY_BOT && t.amount < 0);
    if (!out) return;
    const back = tt.find(t => t.token_id === LENNY_TOKEN && t.account === LENNY_BOT && t.amount > 0);
    if (back) return;
    const recipients = tt.filter(t => t.token_id === LENNY_TOKEN && t.amount > 0 && t.account !== LENNY_BOT);
    recipients.forEach(r => {
      if (STAKING_EXCLUDED.has(r.account)) return;
      if (!stakingByWallet[r.account]) stakingByWallet[r.account] = { total: 0, txCount: 0, purchased: null };
      stakingByWallet[r.account].total += r.amount;
      stakingByWallet[r.account].txCount++;
    });
  });
  state.stakingByWallet = stakingByWallet;
  console.log('[staking]', txns.length, 'Harvey txns,', Object.keys(stakingByWallet).length, 'stakers');
}

async function loadStakingPurchases(state) {
  const wallets = Object.keys(state.stakingByWallet || {});
  if (!wallets.length) return;
  const BATCH = 5;
  for (let i = 0; i < wallets.length; i += BATCH) {
    const batch = wallets.slice(i, i + BATCH);
    await Promise.all(batch.map(async w => {
      let bought = 0;
      let url = `${MIRROR}/transactions?account.id=${w}&transactiontype=CRYPTOTRANSFER&order=asc&limit=100&timestamp=gte:${STAKING_S1_START}&timestamp=lt:${STAKING_S1_END}`;
      let guard = 0;
      try {
        while (url && guard < 20) {
          guard++;
          const d = await api(url);
          const txns = d.transactions || [];
          for (const tx of txns) {
            const tt = tx.token_transfers || [];
            const inAmt = tt.filter(t => t.token_id === LENNY_TOKEN && t.account === w && t.amount > 0).reduce((s, t) => s + t.amount, 0);
            if (inAmt <= 0) continue;
            const fromHarvey = tt.some(t => t.token_id === LENNY_TOKEN && t.account === LENNY_BOT && t.amount < 0);
            if (fromHarvey) continue;
            bought += inAmt;
          }
          const next = d.links && d.links.next;
          if (!next) break;
          url = BASE + next;
        }
      } catch (e) { /* leave purchased at 0 for this wallet */ }
      state.stakingByWallet[w].purchased = bought;
    }));
    await sleep(100);
  }
  const totalBought = Object.values(state.stakingByWallet).reduce((s, w) => s + (w.purchased || 0), 0) / 1e6;
  console.log('[staking buys] DONE — total bought during season:', totalBought.toFixed(2), 'LENNY');
}

async function loadLP(state) {
  const lpTxns = [];
  const allResults = await Promise.all(LP_ROUNDS.map(r =>
    fetchAll(`/transactions?account.id=${LP_SENDER}&transactiontype=CRYPTOTRANSFER&limit=100&order=asc&timestamp=gt:${r.gt}&timestamp=lt:${r.lt}`, 'transactions', 500)
      .then(txns => ({ txns, label: r.label }))
      .catch(() => ({ txns: [], label: r.label }))
  ));
  allResults.forEach(({ txns }) => {
    txns.forEach(tx => {
      (tx.token_transfers || []).forEach(tt => {
        if (tt.token_id === LP_TOKEN_ID && tt.amount > 0 && tt.account !== LP_SENDER) {
          lpTxns.push({ recipient: tt.account, amount: tt.amount });
        }
      });
    });
  });
  state.lpTxns = lpTxns;
  // Current LP balances for HBAR-LENNY
  const lpCurrentBalances = {};
  const allBals = await fetchAll('/tokens/' + LP_TOKEN_ID + '/balances?limit=100&order=desc', 'balances', 100000);
  allBals.forEach(b => { lpCurrentBalances[b.account] = parseInt(b.balance || 0); });
  state.lpCurrentBalances = lpCurrentBalances;
  console.log('[lp]', lpTxns.length, 'airdrop txns,', Object.keys(lpCurrentBalances).length, 'LP holders');
}

async function loadDaVinci(state) {
  // Per-wallet $LENNY locks/burns (whole-LENNY units, ÷1e6)
  const [burnsResp, locksResp] = await Promise.all([
    jget(DVINCI + '/tokens/' + LENNY_TOKEN + '/burns?page=1&limit=100'),
    jget(DVINCI + '/tokens/' + LENNY_TOKEN + '/locks?page=1&limit=100'),
  ]);
  const burns = burnsResp?.burns || [];
  const locks = locksResp?.locks || [];
  const llbw = {}, lbbw = {};
  locks.forEach(l => { const w = l.beneficiaryId || l.beneficiary || l.owner || l.account; if (w) llbw[w] = (llbw[w] || 0) + parseInt(l.amount || 0) / 1e6; });
  burns.forEach(b => { const w = b.accountId || b.burner || b.owner || b.account; if (w) lbbw[w] = (lbbw[w] || 0) + parseInt(b.amount || 0) / 1e6; });
  state.lennyLocksByWallet = llbw;
  state.lennyBurnsByWallet = lbbw;

  // Per-pool LP locks/burns (USD-valued via per-pool LP price) + liqPools table
  const lpLocksByWallet = {}, lpBurnsByWallet = {};
  const liqPools = [];
  const div = 1e8;
  await Promise.all(LENNY_POOLS.map(async p => {
    try {
      const lpIdNum = parseInt(p.lpTokenId.split('.')[2]);
      const fallbackContractId = '0.0.' + (lpIdNum - 1);
      const [poolStats, tokenBurns, tokenLocks, mirrorInfo, balResp] = await Promise.all([
        p.poolId ? jget(DVINCI + '/pools/' + p.poolId) : Promise.resolve(null),
        jget(DVINCI + '/tokens/' + p.lpTokenId + '/burns?page=1&limit=100'),
        jget(DVINCI + '/tokens/' + p.lpTokenId + '/locks?page=1&limit=100'),
        api('/tokens/' + p.lpTokenId).catch(() => null),
        api('/tokens/' + LENNY_TOKEN + '/balances?account.id=' + fallbackContractId + '&limit=1').catch(() => null),
      ]);
      const total = parseInt(mirrorInfo?.total_supply || 0) / div;
      const lennyInPool = (balResp?.balances?.[0]?.balance || 0) / 1e6;
      const locked = poolStats?.locks?.lockedAmount
        ? parseInt(poolStats.locks.lockedAmount) / div
        : (tokenLocks?.locks || []).reduce((s, l) => s + parseInt(l.amount || 0), 0) / div;
      const burned = poolStats?.burns?.amount
        ? parseInt(poolStats.burns.amount) / div
        : (tokenBurns?.burns || []).reduce((s, b) => s + parseInt(b.amount || 0), 0) / div;
      const lennyUsd = state.lennyUsd || 0;
      const poolTVL = lennyInPool > 0 && lennyUsd > 0 ? 2 * lennyInPool * lennyUsd : 0;
      const effectiveTotal = Math.max(total, burned, locked);
      const lpPx = effectiveTotal > 0 && poolTVL > 0 ? poolTVL / effectiveTotal : 0;
      const isHbarLenny = p.lpTokenId === '0.0.9480975';
      const finalLpPx = isHbarLenny && state.lpPriceUsd ? state.lpPriceUsd : lpPx;
      if (finalLpPx > 0) {
        (tokenLocks?.locks || []).forEach(l => { const w = l.beneficiaryId || l.beneficiary || l.owner || l.account; if (w) lpLocksByWallet[w] = (lpLocksByWallet[w] || 0) + parseInt(l.amount || 0) / div * finalLpPx; });
        (tokenBurns?.burns || []).forEach(b => { const w = b.accountId || b.burner || b.owner || b.account; if (w) lpBurnsByWallet[w] = (lpBurnsByWallet[w] || 0) + parseInt(b.amount || 0) / div * finalLpPx; });
      }
      liqPools.push({ lpTokenId: p.lpTokenId, lpPriceUsd: finalLpPx });
    } catch (e) {
      liqPools.push({ lpTokenId: p.lpTokenId, lpPriceUsd: 0 });
    }
  }));
  state.lpLocksByWallet = lpLocksByWallet;
  state.lpBurnsByWallet = lpBurnsByWallet;
  state.liqPools = liqPools;
  console.log('[davinci] LENNY locks:', Object.keys(llbw).length, 'burns:', Object.keys(lbbw).length, '| LP locks:', Object.keys(lpLocksByWallet).length, 'burns:', Object.keys(lpBurnsByWallet).length);
}

async function loadLPHolderBalances(state) {
  const allPools = {};
  await Promise.all(LENNY_POOLS.map(async pool => {
    try {
      const bals = await fetchAll('/tokens/' + pool.lpTokenId + '/balances?limit=100&order=desc', 'balances', 100000);
      const map = {};
      bals.forEach(b => { const bal = parseInt(b.balance); if (bal > 0) map[b.account] = bal; });
      allPools[pool.lpTokenId] = map;
    } catch (e) { allPools[pool.lpTokenId] = {}; }
  }));
  state.lpBalAllPools = allPools;
  const totalWallets = new Set(Object.values(allPools).flatMap(m => Object.keys(m))).size;
  console.log('[lpbal]', LENNY_POOLS.length, 'pools,', totalWallets, 'unique LP holders');
}

// SilkSuite LENNY LP held (NFT positions valued in HBAR via the SilkSuite API). Ported from
// the command center's loadSilkSuiteLpPositions(). Needs state.hbarUsd (run after computePrices).
async function loadSilkSuiteLpPositions(state) {
  state.silkLpUsdByWallet = {};
  try {
    const nfts = await fetchAll('/tokens/' + SILK_LP_NFT_ID + '/nfts?limit=100&order=desc', 'nfts', 20000);
    const live = nfts.filter(n => !n.deleted);
    if (!live.length) return;
    const ownerBySerial = {};
    live.forEach(n => { ownerBySerial[String(n.serial_number)] = n.account_id; });
    const serials = live.map(n => n.serial_number);
    const BATCH = 400;
    let hostIdx = 0;
    for (let i = 0; i < serials.length; i += BATCH) {
      const batch = serials.slice(i, i + BATCH);
      const qs = batch.map(s => 'serialNumbers=' + s).join('&');
      for (let attempt = 0; attempt < SILK_API_HOSTS.length; attempt++) {
        const host = SILK_API_HOSTS[hostIdx % SILK_API_HOSTS.length]; hostIdx++;
        try {
          const r = await fetch(host + '/pools/positions?tokenId=' + SILK_LP_NFT_ID + '&' + qs);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const positions = await r.json();
          (Array.isArray(positions) ? positions : []).forEach(pos => {
            if (!SILK_LENNY_POOL_WALLETS.has(pos.poolWallet)) return;
            const owner = ownerBySerial[String(pos.serialNumber)];
            if (!owner) return;
            const hbarVal = parseFloat(pos.liquidity?.investment?.exit ?? pos.liquidity?.investment?.entry ?? 0);
            if (!hbarVal || !state.hbarUsd) return;
            state.silkLpUsdByWallet[owner] = (state.silkLpUsdByWallet[owner] || 0) + hbarVal * state.hbarUsd;
          });
          break; // success, no need to try another host
        } catch (e) { /* try next host on failure */ }
      }
      if (i + BATCH < serials.length) await new Promise(res => setTimeout(res, 150));
    }
    console.log('[silklp]', serials.length, 'positions scanned,', Object.keys(state.silkLpUsdByWallet).length, 'LENNY-paired wallets');
  } catch (e) { console.warn('[silklp] error:', e.message); }
}

// ─── Ticket math (per wallet, ported from the dashboard helpers) ────
function calcAllPoolsLpUsd(state, wallet) {
  let total = 0;
  if (!state.lpBalAllPools || !state.liqPools) return 0;
  LENNY_POOLS.forEach(pool => {
    const bal = state.lpBalAllPools[pool.lpTokenId]?.[wallet] || 0;
    if (bal <= 0) return;
    const pi = state.liqPools.find(p => p.lpTokenId === pool.lpTokenId);
    if (pi && pi.lpPriceUsd) total += (bal / 1e8) * pi.lpPriceUsd;
  });
  return total;
}

function stakingHeld(state, wallet, lennyRaw) {
  const w = state.stakingByWallet?.[wallet];
  if (!w) return null;
  const received = w.total;
  const cur = lennyRaw != null ? lennyRaw : (state.lennyBalances?.[wallet] || 0);
  const kept = Math.min(cur, received);
  const extra = (w.purchased != null) ? w.purchased : null;
  const pct = received > 0 ? (kept / received) * 100 : 0;
  let status;
  if (extra > 0 && cur >= received) status = 'accumulator';
  else if (cur >= received) status = 'holding';
  else if (pct >= 80) status = 'mostly';
  else if (pct >= 30) status = 'partial';
  else if (pct > 0) status = 'sold-most';
  else status = 'sold-all';
  return { received, current: cur, kept, extra, pct, status };
}

function lpRoundsRetainedTickets(state, wallet) {
  const txns = (state.lpTxns || []).filter(t => t.recipient === wallet);
  if (!txns.length) return 0;
  const cur = (state.lpCurrentBalances || {})[wallet] || 0;
  if (cur <= 0) return 0;
  const amounts = txns.map(t => t.amount).sort((a, b) => a - b);
  let count = 0, sum = 0;
  for (const amt of amounts) { sum += amt; if (sum <= cur) count++; else break; }
  return count;
}

// Compute the full ticket breakdown for one wallet from loaded state.
function ticketsForWallet(state, wallet, lennyRaw) {
  const c = state.nftCounts?.[wallet] || { gold: 0, nickel: 0, penny: 0, peach: 0 };
  const isContract = RAFFLE_CONTRACT_WALLETS.has(wallet);
  const lenny = lennyRaw != null ? lennyRaw : (state.lennyBalances?.[wallet] || 0);
  const lennyUsd = state.lennyUsd;

  const nftTix = isContract ? 0 : calcNftTix(c);
  const lennyTix = isContract ? 0 : lennyTickets(lenny);

  let stakingTix = 0;
  if (!isContract) {
    const sh = stakingHeld(state, wallet, lenny);
    if (sh && (sh.status === 'holding' || sh.status === 'accumulator')) stakingTix += 1;
    if (sh && sh.status === 'accumulator') stakingTix += 1;
  }
  const lpRoundsTix = isContract ? 0 : lpRoundsRetainedTickets(state, wallet);
  const lockedLennyTix = isContract ? 0 : Math.floor(((state.lennyLocksByWallet || {})[wallet] || 0) / LENNY_PER_TICKET);
  const burnedLennyTix = isContract ? 0 : 2 * Math.floor(((state.lennyBurnsByWallet || {})[wallet] || 0) / LENNY_PER_TICKET);
  const lockedLpTix = (isContract || !lennyUsd) ? 0 : Math.floor(((state.lpLocksByWallet || {})[wallet] || 0) / (LENNY_PER_TICKET * lennyUsd));
  const burnedLpTix = (isContract || !lennyUsd) ? 0 : 2 * Math.floor(((state.lpBurnsByWallet || {})[wallet] || 0) / (LENNY_PER_TICKET * lennyUsd));
  const heldLpUsd = calcAllPoolsLpUsd(state, wallet) + ((state.silkLpUsdByWallet || {})[wallet] || 0);
  const heldLpTix = (isContract || !lennyUsd) ? 0 : Math.floor(heldLpUsd / (LENNY_PER_TICKET * lennyUsd));

  const tickets = nftTix + lennyTix + stakingTix + lpRoundsTix + lockedLennyTix + lockedLpTix + heldLpTix + burnedLennyTix + burnedLpTix;
  return {
    wallet, isContract,
    nftCounts: c,
    nftTotal: c.gold + c.nickel + c.penny + c.peach,
    lennyBal: lenny,
    nftTickets: nftTix, lennyTickets: lennyTix, stakingTix, lpRoundsTix,
    lockedLennyTix, lockedLpTix, heldLpTix, burnedLennyTix, burnedLpTix,
    tickets,
  };
}

// Union of every wallet with any ticket-relevant activity, then compute breakdowns.
function buildAllFromState(state) {
  const walletSet = new Set([
    ...Object.keys(state.nftCounts || {}),
    ...Object.keys(state.lennyBalances || {}),
    ...Object.keys(state.stakingByWallet || {}),
    ...Object.keys(state.lennyLocksByWallet || {}),
    ...Object.keys(state.lennyBurnsByWallet || {}),
    ...Object.keys(state.lpLocksByWallet || {}),
    ...Object.keys(state.lpBurnsByWallet || {}),
    ...Object.keys(state.lpCurrentBalances || {}),
    ...Object.values(state.lpBalAllPools || {}).flatMap(m => Object.keys(m || {})),
    ...Object.keys(state.silkLpUsdByWallet || {}),
  ]);
  const out = {};
  walletSet.forEach(w => { if (!w) return; const b = ticketsForWallet(state, w); if (b.tickets > 0) out[w] = b; });
  return out;
}

// ─── Refresh cycle ──────────────────────────────────────────────
async function refresh() {
  if (cache.building) { console.log('[refresh] already running, skip'); return; }
  cache.building = true;
  const t0 = Date.now();
  console.log('[refresh] starting…');
  try {
    const state = {};
    await computePrices(state);
    // Order matters: pricing → DaVinci (needs lennyUsd + lpPriceUsd) → held LP.
    await Promise.all([
      loadNftHolders(state),
      loadLennyBalances(state),
      loadLP(state),
      loadDaVinci(state),
      loadLPHolderBalances(state),
      loadSilkSuiteLpPositions(state),
    ]);
    await loadStaking(state);
    await loadStakingPurchases(state); // expensive, per-staker; runs server-side only
    const tickets = buildAllFromState(state);
    cache.tickets = tickets;
    cache.meta = {
      builtAt: Date.now(),
      hbarUsd: state.hbarUsd,
      lennyUsd: state.lennyUsd,
      lpPriceUsd: state.lpPriceUsd,
      totalWallets: Object.keys(tickets).length,
    };
    writeDiskCache('tickets', { tickets, meta: cache.meta });
    console.log(`[refresh] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${cache.meta.totalWallets} wallets with tickets`);
  } catch (e) {
    console.error('[refresh] FAILED:', e.message);
  } finally {
    cache.building = false;
  }
}

// Seed from disk so a cold boot serves instantly while first refresh runs.
(function seed() {
  const disk = readDiskCache('tickets');
  if (disk && disk.tickets) {
    cache.tickets = disk.tickets;
    cache.meta = disk.meta || cache.meta;
    console.log('[seed] loaded', Object.keys(cache.tickets).length, 'wallets from disk cache');
  }
})();

// ─── Routes ─────────────────────────────────────────────────────
function cors(res) { res.set('Access-Control-Allow-Origin', '*'); }

app.get('/api/tickets/:wallet', (req, res) => {
  cors(res);
  const w = String(req.params.wallet || '').trim();
  if (!/^0\.0\.\d+$/.test(w)) return res.status(400).json({ error: 'Invalid wallet ID. Format: 0.0.123456' });
  const b = cache.tickets[w] || {
    wallet: w, isContract: RAFFLE_CONTRACT_WALLETS.has(w),
    nftCounts: { gold: 0, nickel: 0, penny: 0, peach: 0 }, nftTotal: 0, lennyBal: 0,
    nftTickets: 0, lennyTickets: 0, stakingTix: 0, lpRoundsTix: 0,
    lockedLennyTix: 0, lockedLpTix: 0, heldLpTix: 0, burnedLennyTix: 0, burnedLpTix: 0, tickets: 0,
  };
  res.json({ breakdown: b, meta: cache.meta });
});

app.get('/api/meta', (req, res) => { cors(res); res.json(cache.meta); });
app.get('/api/health', (req, res) => { cors(res); res.json({ ok: true, builtAt: cache.meta.builtAt, building: cache.building }); });

// Serve the lookup page at / and /raffle (for lennylens.xyz/raffle routing).
// Only the public/ folder is served — keeps server.js / package.json private.
app.get(['/', '/raffle'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'raffle-lookup.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Startup ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n( ͡° ͜ʖ ͡°)  LENNY Raffle Lookup — http://localhost:${PORT}\n`);
  refresh(); // initial build
  setInterval(refresh, 5 * 60 * 1000);
});
