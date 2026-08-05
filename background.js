/**
 * FOMO 交易看板 - 后台服务
 * 职责：
 *  1. 通过 webRequest 自动捕获 fomo.family 页面请求里的 Authorization Bearer JWT
 *  2. 解析 JWT 中的用户 ID（sub 字段）
 *  3. 代理所有业务 API 请求（规避 CORS），统一注入 X-Supported-Chains 头
 *  4. 响应 popup / dashboard 的消息
 */
const API_HOST = "https://prod-api.fomo.family";
const CHAINS = "1,56,143,4663,8453,1399811149";

let lastJwt = null;

/* ---------- 0. 评论翻译（Google 翻译非官方接口） ---------- */
const translateCache = new Map();

async function translate(text) {
  if (!text || typeof text !== "string") return { ok: true, text: "" };
  const trimmed = text.trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed) || /[\u4e00-\u9fff]/.test(trimmed)) {
    // 不含拉丁字母（数字/表情/纯中文）→ 无需翻译；已含中文→ 保留原文
    return { ok: true, text: trimmed };
  }
  if (translateCache.has(trimmed)) return { ok: true, text: translateCache.get(trimmed) };
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=" + encodeURIComponent(trimmed);
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  let out = "";
  try {
    out = (data[0] || []).map((seg) => (seg && seg[0]) || "").join("");
  } catch (_e) {
    out = trimmed;
  }
  if (out) translateCache.set(trimmed, out);
  return { ok: true, text: out || trimmed };
}

/* ---------- 1. 自动捕获登录态 ---------- */
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const auth = (details.requestHeaders || []).find(
        (h) => h.name.toLowerCase() === "authorization"
      );
      if (auth && auth.value && auth.value.startsWith("Bearer ") && auth.value.length > 40) {
        const token = auth.value.slice(7);
        if (token !== lastJwt) {
          lastJwt = token;
          chrome.storage.local.set({ jwt: token, capturedAt: Date.now() });
          // 从 JWT payload 解析用户ID
          try {
            const seg = token.split(".")[1];
            const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
            const payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
            const uid = payload.sub || payload.user_id || payload.userId || payload.wallet_address || null;
            if (uid) chrome.storage.local.set({ userId: uid });
            chrome.storage.local.set({ userName: payload.name || payload.handle || null });
          } catch (_e) { /* 解析失败不阻塞 */ }
        }
      }
    } catch (_e) { /* 静默 */ }
  },
  { urls: ["https://prod-api.fomo.family/*"] },
  ["requestHeaders", "extraHeaders"]
);

/* ---------- 2. API 代理 ---------- */
async function call(path, options = {}) {
  const { method = "GET", body, params } = options;
  const stored = await chrome.storage.local.get(["jwt"]);
  if (!stored.jwt) throw new Error("NO_JWT");
  let url = API_HOST + path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) { v.forEach((x) => qs.append(k, x)); }
      else qs.append(k, v);
    }
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + stored.jwt,
      "X-Supported-Chains": CHAINS,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  if (res.status === 401) {
    // JWT 失效，清掉让用户重新登录/粘贴
    await chrome.storage.local.remove("jwt");
  }
  // 捕获排行榜响应 → 更新 uid→排行映射（供推送 + 前端排行徽章）
  if (res.ok && res.status === 200 && path.includes("/v2/leaderboard")) {
    try {
      const ro = data.responseObject || data || {};
      if (Array.isArray(ro.leaderboard)) updateRankMap(ro.leaderboard);
    } catch (_e) {}
  }
  return { ok: res.ok, status: res.status, data };
}

/* ---------- 2.5 Top 榜排行映射 + 买入推送 ---------- */
const lbRankMap = new Map(); // uid -> 排行(1-based)
let lbRankTs = 0;
let lbBackoffUntil = 0; // 排行榜接口 429 退避截止时间
let lbBackoffMs = 60000; // 退避时长（指数增长到 5 分钟）
const pushedTradeKeys = new Set(); // 本次运行去重
const lastPushByUser = new Map(); // uid -> 时间戳（同用户限频 5 分钟）
const PUSH_MAX = 30; // 默认推送 Top 30
const PUSH_MIN_USD = 100; // 扩展规则：任何人买入金额阈值(默认 $100)
const PUSH_THESIS_MIN_FOLLOWERS = 1000; // 扩展规则：发观点用户的最低粉丝数

const followersByUid = new Map(); // uid -> 粉丝数（排行榜/用户详情/条目自带 汇聚缓存）

function bgFmtNum(n) {
  n = Number(n || 0);
  if (!isFinite(n)) return "-";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(0) + "K";
  return String(Math.round(n));
}

function updateRankMap(leaderboard) {
  if (!Array.isArray(leaderboard)) return;
  lbRankMap.clear();
  leaderboard.forEach((u, i) => {
    if (u && u.id) {
      lbRankMap.set(u.id, i + 1);
      if (u.followers != null) followersByUid.set(u.id, Number(u.followers));
    }
  });
  lbRankTs = Date.now();
}

async function refreshRankMap() {
  if (Date.now() < lbBackoffUntil) return; // 429 退避期不请求
  try {
    const r = await call("/v2/leaderboard?limit=50");
    if (r.ok && r.status === 200) {
      const ro = r.data.responseObject || r.data || {};
      if (Array.isArray(ro.leaderboard)) updateRankMap(ro.leaderboard);
      lbBackoffMs = 60000;
    } else if (r.status === 429) {
      lbBackoffUntil = Date.now() + lbBackoffMs;
      lbBackoffMs = Math.min(lbBackoffMs * 2, 5 * 60 * 1000);
    }
  } catch (_e) {}
}

function bgChainName(nid) {
  const names = { 1: "Ethereum", 56: "BSC", 143: "X1", 4663: "Ethos", 8453: "Base", 1399811149: "Solana" };
  return names[nid] || "Chain " + nid;
}

function bgShortUsd(n) {
  n = Number(n || 0);
  if (!isFinite(n) || n <= 0) return "";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

/* 解析交易条目的真实用户ID：
 * tradingActivity 条目的顶层 userId 常为 null，真实用户在嵌套 body.topTraders[0].id
 * （与前端 dashboard 去匿名逻辑保持一致，否则永远匹配不上排行榜 → 永不推送） */
function sigUid(sig) {
  if (!sig) return null;
  if (sig.userId) return sig.userId;
  const tt = sig.body && Array.isArray(sig.body.topTraders) && sig.body.topTraders[0];
  return (tt && tt.id) || null;
}

function sigDisplayName(sig) {
  if (sig && sig.displayName) return sig.displayName;
  const tt = sig && sig.body && Array.isArray(sig.body.topTraders) && sig.body.topTraders[0];
  return (tt && (tt.displayName || tt.userHandle)) || null;
}

/* 判定是否应推送（两条规则，命中其一即可）：
 * ① Top 榜用户买入：type === swap_buy 且 排行 ≤ topN（原有规则，金额不限）
 * ② 全网大额买入：任何人 swap_buy 且 usdAmount ≥ minUsd（默认 $100）
 * 返回 { uid, rank, byAmount, usdAmount }；都不命中返回 null。
 * 注意：tradingActivity 顶层 userId 常为 null，真实用户在 body.topTraders[0]，
 * 由 sigUid() 统一兜底，否则永远匹配不上排行榜 → 永不推送。
 */
function shouldPush(sig, topN, minUsd) {
  if (!sig || sig.type !== "swap_buy") return null;
  const uid = sigUid(sig);
  if (!uid) return null;
  const rank = lbRankMap.get(uid);
  const usdAmount = Number(sig.usdAmount || 0);
  const byAmount = usdAmount >= Number(minUsd || 0);
  const topHit = rank && rank <= topN;
  if (!topHit && !byAmount) return null;
  const now = Date.now();
  const last = lastPushByUser.get(uid) || 0;
  if (now - last < 5 * 60 * 1000) return null; // 同用户 5 分钟限频
  return { uid, rank: topHit ? rank : 0, byAmount, usdAmount };
}

async function pushTopBuy(sig, info) {
  const uid = sigUid(sig) || "";
  // 去重键：优先交易 ID；tradingActivity 条目通常没有顶层 tradeId/id，
  // 退回 用户+代币+金额+时间 组合键，避免 key 为空导致永远不推送
  const key = String(sig.tradeId || sig.id || "") ||
    [uid, sig.tokenAddress || (sig.token && sig.token.address) || "", sig.usdAmount || "", sig.createdAt || ""].join("|");
  if (!key) return;
  if (pushedTradeKeys.has(key)) return;
  // 同用户 5 分钟限频（双保险：shouldPush 也查，这里兜底防绕过）
  const now = Date.now();
  const last = lastPushByUser.get(uid) || 0;
  if (now - last < 5 * 60 * 1000) return;
  // 跨生命周期去重（storage 持久化）
  try {
    const stored = await chrome.storage.local.get("fomoPushedTrades");
    const arr = stored.fomoPushedTrades || [];
    if (arr.includes(key)) return;
    pushedTradeKeys.add(key);
    arr.push(key);
    if (arr.length > 2000) arr.splice(0, arr.length - 1500);
    await chrome.storage.local.set({ fomoPushedTrades: arr });
  } catch (_e) { return; }

  lastPushByUser.set(uid, Date.now());
  const price = Number(sig.price || 0);
  const mcap = Number(sig.marketCap || 0);
  const followers = followersByUid.get(uid);
  const name = sigDisplayName(sig) || "大V";
  const ticker = sig.ticker || (sig.token && sig.token.symbol) || "?";
  // 标题：Top 榜命中显示名次；全网大额命中显示金额
  const title = info && info.rank
    ? `#${info.rank} ${name} 买入 ${ticker}`
    : `🔔 ${name} 买入 ${ticker}（${bgShortUsd(info && info.usdAmount)}）`;
  const line = [
    bgShortUsd(info && info.usdAmount) ? "金额 " + bgShortUsd(info.usdAmount) : "",
    price > 0 ? "@$" + price.toFixed(price >= 1 ? 2 : 6) : "",
    mcap > 0 ? "市值 " + bgShortUsd(mcap) : "",
    bgChainName(sig.networkId),
    followers ? "粉丝 " + bgFmtNum(followers) : "",
  ].filter(Boolean).join(" · ");
  try {
    await chrome.notifications.create("topbuy-" + key, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: line || (ticker + " 新交易"),
      priority: 2,
    });
  } catch (_e) {}
  // 广播给打开着的 dashboard（可显示最近推送）
  chrome.runtime.sendMessage({ action: "topBuyPush", sig, rank: (info && info.rank) || 0, byAmount: !!(info && info.byAmount) }).catch(() => {});
}

/* ---------- 2.6 tradingActivity 统一缓存 ----------
 * 收敛所有 /feed/tradingActivity 请求到后台唯一来源：
 *  - 单飞：同一时刻最多一个请求在途，多调用方共享结果
 *  - 缓存：30 秒内直接复用，避免 dashboard/popup/搜索各自发请求
 *  - 429 退避：被限流后指数退避（60s→5min），退避期内返回旧缓存不再打接口
 */
let taCache = { items: [], ts: 0 };
let taInFlight = null;
let taBackoffUntil = 0;
let taBackoffMs = 60000;

async function taFetch(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && taCache.ts && now - taCache.ts < 10000) return taCache; // 10s 缓存
  if (now < taBackoffUntil) return taCache;                    // 429 退避期：不请求
  if (taInFlight) return taInFlight;                           // 单飞：等待在途请求
  taInFlight = (async () => {
    try {
      const r = await call("/feed/tradingActivity", { params: { limit: 100 } });
      if (r.ok && r.status === 200) {
        const ro = r.data.responseObject || r.data || {};
        taCache = { items: ro.items || [], ts: Date.now() };
        taBackoffMs = 60000; // 成功重置退避
      } else if (r.status === 429) {
        taBackoffUntil = Date.now() + taBackoffMs;
        taBackoffMs = Math.min(taBackoffMs * 2, 5 * 60 * 1000); // 60s→2m→4m→5m
      }
    } catch (_e) {}
    return taCache;
  })();
  try { return await taInFlight; } finally { taInFlight = null; }
}

async function pollTopBuys() {
  let cfg = {};
  try { cfg = await chrome.storage.local.get(["pushEnabled", "pushTopN", "pushMinUsd"]); } catch (_e) {}
  if (cfg.pushEnabled === false) return;
  const topN = cfg.pushTopN || PUSH_MAX;
  const minUsd = cfg.pushMinUsd != null ? Number(cfg.pushMinUsd) : PUSH_MIN_USD;
  const cache = await taFetch();
  for (const sig of cache.items) {
    const info = shouldPush(sig, topN, minUsd);
    if (info) pushTopBuy(sig, info);
  }
}

/* 接收 WebSocket 实时推送的交易信号 */
async function handleRealtimeTradeSignal(payload) {
  if (!payload) return;
  const items = Array.isArray(payload) ? payload : (payload.items || [payload]);
  let cfg = {};
  try { cfg = await chrome.storage.local.get(["pushEnabled", "pushTopN", "pushMinUsd"]); } catch (_e) {}
  if (cfg.pushEnabled === false) return;
  const topN = cfg.pushTopN || PUSH_MAX;
  const minUsd = cfg.pushMinUsd != null ? Number(cfg.pushMinUsd) : PUSH_MIN_USD;

  for (const item of items) {
    const sig = item.trade || item.signal || item;
    if (sig && sigUid(sig)) {
      const info = shouldPush(sig, topN, minUsd);
      if (info) pushTopBuy(sig, info);
    }
  }
}

/* ---------- 2.7 观点推送（粉丝 ≥1k 的用户发布观点 thesis/manual） ---------- */
const thesisKeys = new Set();      // 本次运行去重
const followersUnknown = new Set(); // uid 已尝试拉取但无粉丝数据（避免反复打用户详情接口）
let feedCache = { items: [], ts: 0 };
let feedInFlight = null;
let feedBackoffUntil = 0;
let feedBackoffMs = 60000;

/* 获取作者粉丝数：优先排行榜汇聚缓存 → 条目自带 → 用户详情接口兜底 */
async function getFollowers(uid, item) {
  if (followersByUid.has(uid)) return followersByUid.get(uid);
  if (followersUnknown.has(uid)) return 0;
  const b = item.body || {};
  const cand = Number(item.followers) ||
    (item.user && Number(item.user.followers)) ||
    (b.user && Number(b.user.followers)) ||
    (b.followers != null ? Number(b.followers) : 0);
  if (cand) { followersByUid.set(uid, cand); return cand; }
  // 兜底：只有拿到 handle 才去拉用户详情（可能加重接口压力，缺失则放弃）
  const handle = item.userHandle || (item.user && item.user.userHandle) || b.userHandle;
  if (!handle) { followersUnknown.add(uid); return 0; }
  try {
    const r = await call("/v2/users/userHandle/" + encodeURIComponent(handle));
    if (r.ok && r.status === 200) {
      const ro = r.data.responseObject || r.data || {};
      const u = ro.user || ro || {};
      const n = Number(u.followers || 0);
      if (n) followersByUid.set(uid, n);
      else followersUnknown.add(uid);
      return n;
    }
    if (r.status === 429 || r.status === 404) followersUnknown.add(uid);
  } catch (_e) { followersUnknown.add(uid); }
  return 0;
}

async function pushThesis(item) {
  const b = item.body || {};
  const uid = item.userId || b.userId || (item.user && item.user.id);
  if (!uid) return;
  const handle = item.userHandle || (item.user && item.user.userHandle) || b.userHandle;
  const name = item.displayName || (item.user && item.user.displayName) || b.displayName || handle || "大V";
  // 去重键：用户+条目ID+时间（feed 条目可能无顶层 id，退回时间戳）
  const key = "thesis|" + uid + "|" + (item.id || item.feedItemId || "") + "|" + (item.createdAt || "");
  if (!key || thesisKeys.has(key)) return;
  const now = Date.now();
  const last = lastPushByUser.get(uid) || 0;
  if (now - last < 5 * 60 * 1000) return; // 同用户 5 分钟限频
  const followers = await getFollowers(uid, item);
  if (followers < PUSH_THESIS_MIN_FOLLOWERS) return; // 粉丝不足不推送
  // 跨生命周期去重（storage 持久化）
  try {
    const stored = await chrome.storage.local.get("fomoPushedThesis");
    const arr = stored.fomoPushedThesis || [];
    if (arr.includes(key)) return;
    thesisKeys.add(key);
    arr.push(key);
    if (arr.length > 2000) arr.splice(0, arr.length - 1500);
    await chrome.storage.local.set({ fomoPushedThesis: arr });
  } catch (_e) { return; }

  lastPushByUser.set(uid, Date.now());
  const text = String(b.text || b.message || b.comment || b.thesisText || b.entryMessage || "").trim();
  const token = b.tokenSymbol || b.tokenName || item.ticker ||
    (b.token && (b.token.symbol || b.token.name)) || "";
  const title = `📣 ${name} 发布观点${token ? " · " + token : ""}`;
  const line = [
    text ? text.slice(0, 120) : "",
    "粉丝 " + bgFmtNum(followers),
    token ? "代币 " + token : "",
  ].filter(Boolean).join(" | ");
  try {
    await chrome.notifications.create("thesis-" + key, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: line || "新观点",
      priority: 2,
    });
  } catch (_e) {}
  // 广播给打开着的 dashboard（可显示最近推送）
  chrome.runtime.sendMessage({ action: "thesisPush", item, followers }).catch(() => {});
}

/* /feed 统一缓存（只取 thesis_created / manual 两类，30s 缓存 + 429 退避，防限流） */
async function feedFetch() {
  const now = Date.now();
  if (feedCache.ts && now - feedCache.ts < 30000) return feedCache;
  if (now < feedBackoffUntil) return feedCache;
  if (feedInFlight) return feedInFlight;
  feedInFlight = (async () => {
    try {
      const r = await call("/feed", {
        params: {
          limit: 50,
          feedTypes: ["thesis_created", "manual"],
        },
      });
      if (r.ok && r.status === 200) {
        const ro = r.data.responseObject || r.data || {};
        feedCache = { items: ro.feed || ro.items || [], ts: Date.now() };
        feedBackoffMs = 60000;
      } else if (r.status === 429) {
        feedBackoffUntil = Date.now() + feedBackoffMs;
        feedBackoffMs = Math.min(feedBackoffMs * 2, 5 * 60 * 1000);
      }
    } catch (_e) {}
    return feedCache;
  })();
  try { return await feedInFlight; } finally { feedInFlight = null; }
}

async function pollThesis() {
  let cfg = {};
  try { cfg = await chrome.storage.local.get(["pushEnabled", "pushThesis"]); } catch (_e) {}
  if (cfg.pushEnabled === false) return;
  if (cfg.pushThesis === false) return; // 观点推送独立开关
  const cache = await feedFetch();
  for (const item of cache.items) {
    const t = String(item.feedType || (item.body && item.body.feedType) || item.type || "").toLowerCase();
    if (!/thesis|manual/.test(t)) continue;
    await pushThesis(item);
  }
}

/* WebSocket feed 主题 → 观点推送（feed 条目非 swap_buy，不会误入买入推送） */
async function handleRealtimeFeed(payload) {
  if (!payload) return;
  const items = Array.isArray(payload) ? payload : (payload.items || [payload]);
  let cfg = {};
  try { cfg = await chrome.storage.local.get(["pushEnabled", "pushThesis"]); } catch (_e) {}
  if (cfg.pushEnabled === false) return;
  if (cfg.pushThesis === false) return;
  for (const item of items) {
    const t = String(item.feedType || (item.body && item.body.feedType) || item.type || "").toLowerCase();
    if (/thesis|manual/.test(t)) await pushThesis(item);
  }
}

/* 心跳驱动：10 秒轮询（买入推送 + 观点推送），排行榜映射每 60 秒刷新一次 */
let lastPollAt = 0;
let lastRankRefreshAt = 0;
async function pollTick() {
  const now = Date.now();
  if (now - lastRankRefreshAt >= 60000) {
    lastRankRefreshAt = now;
    await refreshRankMap();
  }
  if (now - lastPollAt < 10000) return;
  lastPollAt = now;
  await pollTopBuys();
  await pollThesis();
}

/* 通知点击 → 打开看板 */
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("topbuy-") || id.startsWith("thesis-")) {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    chrome.notifications.clear(id);
  }
});

/* ---------- 3. 消息路由 ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === "call") {
    call(msg.path, msg.options)
      .then((r) => sendResponse({ ok: true, r }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
  if (msg && msg.action === "getSession") {
    chrome.storage.local.get(["jwt", "userId", "userName", "capturedAt"]).then((s) => {
      sendResponse({ ok: true, session: s });
    });
    return true;
  }
  if (msg && msg.action === "setJwt") {
    lastJwt = msg.jwt;
    chrome.storage.local.set({ jwt: msg.jwt, userId: msg.userId || "", userName: msg.userName || "", capturedAt: Date.now() }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg && msg.action === "clearSession") {
    lastJwt = null;
    chrome.storage.local.remove(["jwt", "userId", "userName"]).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.action === "getRealtime") {
    sendResponse({ ok: true, connected: wsConnected, ts: Date.now(), list: trendingCache });
    return;
  }
  if (msg && msg.action === "translate") {
    translate(msg.text)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }
  if (msg && msg.action === "getLbRanks") {
    sendResponse({ ok: true, map: Object.fromEntries(lbRankMap), ts: lbRankTs });
    return;
  }
  if (msg && msg.action === "getTa") {
    // 统一交易动态缓存：前端不再各自请求 tradingActivity（防 429）
    taFetch().then((c) => sendResponse({ ok: true, items: c.items, ts: c.ts }));
    return true; // 异步响应
  }
});

/* ---------- 4. WebSocket 实时行情 ---------- */
const WS_URL = "wss://prod-api.fomo.family/ws";
let ws = null;
let wsRetryMs = 1000;
let wsConnected = false;
let trendingCache = [];
let throttleTick = false;

function notifyWsState(on) {
  wsConnected = on;
  chrome.storage.session.set({ wsConnected: on, wsTs: Date.now() }).catch(() => {});
}

function publishTrending() {
  chrome.storage.session.set({ trendingRealtime: { ts: Date.now(), list: trendingCache } }).catch(() => {});
  chrome.runtime.sendMessage({ action: "wsTrending", list: trendingCache }).catch(() => {});
}

function handleTrendingPayload(payload) {
  if (!payload) return;
  if (payload.kind === "snapshot" && Array.isArray(payload.tokens)) {
    trendingCache = payload.tokens.slice(0, 60);
  } else if (payload.kind === "update" && payload.update) {
    const u = payload.update;
    const tok = (u.token || {}).address;
    const nid = (u.token || {}).networkId;
    const i = trendingCache.findIndex((x) => (x.token || {}).address === tok && (x.token || {}).networkId === nid);
    if (i >= 0) trendingCache[i] = u;
    else { trendingCache.unshift(u); trendingCache = trendingCache.slice(0, 60); }
  }
  // 节流：最多每 2 秒写一次 storage + 广播
  if (!throttleTick) {
    throttleTick = true;
    setTimeout(() => { throttleTick = false; publishTrending(); }, 2000);
  }
}

function wsConnect() {
  chrome.storage.local.get(["jwt"]).then(({ jwt }) => {
    if (!jwt) { setTimeout(wsConnect, 5000); return; }
    let socket;
    try { socket = new WebSocket(WS_URL); } catch (_e) { setTimeout(wsConnect, 5000); return; }
    ws = socket;
    socket.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case "challenge":
          socket.send(JSON.stringify({ type: "challengeResponse", jwt }));
          break;
        case "challengeAccepted":
          wsRetryMs = 1000;
          notifyWsState(true);
          socket.send(JSON.stringify({ type: "subscribe", topicType: "trending_tokens", topicId: CHAINS }));
          socket.send(JSON.stringify({ type: "subscribe", topicType: "trading_activity", topicId: CHAINS }));
          socket.send(JSON.stringify({ type: "subscribe", topicType: "feed", topicId: CHAINS }));
          break;
        case "data":
          if (m.topicType === "trending_tokens") handleTrendingPayload(m.payload);
          if (m.topicType === "trading_activity" || m.topicType === "trade") {
            handleRealtimeTradeSignal(m.payload);
          }
          if (m.topicType === "feed") {
            handleRealtimeFeed(m.payload);
          }
          break;
        case "error":
          if (m.code === 1008 || /jwt/i.test(m.message || "")) socket.close(1008);
          break;
      }
    };
    socket.onclose = (e) => {
      notifyWsState(false);
      if (e.code === 1008) {
        // JWT 失效：清掉，待用户重新登录/粘贴
        chrome.storage.local.remove("jwt");
        return;
      }
      setTimeout(wsConnect, wsRetryMs);
      wsRetryMs = Math.min(wsRetryMs * 2, 15000);
    };
    socket.onerror = () => {};
  });
}

/* JWT 更新后重连 WS */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.jwt && changes.jwt.newValue) {
    if (ws) { try { ws.close(); } catch (_e) {} ws = null; }
    wsRetryMs = 1000;
    wsConnect();
  }
});

/* 启动 + 心跳保活 */
wsConnect();
setInterval(pollTick, 10000); // 10 秒高频轮询，保证秒级响应
chrome.alarms.create("heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "heartbeat") {
    chrome.storage.local.get("jwt").then((s) => { lastJwt = s.jwt || null; });
    // WS 若因 SW 休眠断开则重连
    if (!wsConnected) wsConnect();
    // Top 榜买入推送 + 排行映射
    pollTick();
  }
});
