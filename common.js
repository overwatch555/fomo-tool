/* FOMO 看板共享工具（popup/dashboard 共用） */

const CHAIN_NAMES = {
  1: "Ethereum", 56: "BSC", 8453: "Base", 143: "Monad", 10143: "Monad",
  4663: "Robinhood", 1399811148: "Robinhood", 1399811149: "Solana",
  1337: "Testnet",
};

function chainName(nid) {
  if (nid === null || nid === undefined || nid === "") return "未知链";
  return CHAIN_NAMES[nid] || ("Chain " + nid);
}

function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(digits) + "K";
  return Number(n).toFixed(digits < 2 ? 0 : digits);
}

/* 持仓数量格式化：保留小数，避免 fmtNum 把 0.0374 显示成 0 */
function fmtAmount(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (abs >= 1) return Number(n).toFixed(2).replace(/\.?0+$/, "");
  if (abs >= 1e-6) return Number(n).toFixed(8).replace(/\.?0+$/, "");
  return n.toExponential(2);
}

function fmtUsd(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return "$" + n.toFixed(6);
  return "$" + Number(n).toFixed(digits);
}

function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  return (n * 100).toFixed(digits) + "%";
}

function pctClass(n) {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "";
}

function fmtPrice(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  if (n === 0) return "$0";
  if (n >= 1) return "$" + Number(n).toFixed(4);
  if (n >= 0.001) return "$" + Number(n).toFixed(6);
  return "$" + Number(n).toPrecision(3);
}

function timeAgo(iso) {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "-";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 10) return "刚刚";
  if (s < 60) return s + "秒前";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "小时前";
  const d = Math.floor(h / 24);
  return d + "天前";
}

function shortAddr(a, len = 6) {
  if (!a) return "";
  return a.length > len * 2 ? a.slice(0, len) + "…" + a.slice(-4) : a;
}

function avatarUrl(u) {
  return (u && u.profilePictureLink) || "";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function signLabel(type) {
  const map = {
    thesis: "观点",
    trade: "交易",
    swap_buy: "买入",
    swap_sell: "卖出",
    single_user_sell: "平仓",
    multi_user_buy: "👥 集体买入",
    multi_user_sell: "👥 集体卖出",
    new_token_listing: "⚡ 新币上线",
    price_since_listing: "📈 暴涨/拉升",
    user_trade_profit_milestone: "🏆 盈利里程碑",
  };
  return map[type] || type;
}

function feedTypeLabel(type) {
  const map = {
    manual: "手动交易",
    swap_buy: "买入",
    swap_sell: "卖出",
    single_user_sell: "平仓",
    thesis_created: "💡 交易观点",
    multi_user_buy: "👥 巨鲸/集体买入",
    multi_user_sell: "👥 集体抛售",
    new_token_listing: "⚡ 新币上线",
    price_since_listing: "📈 暴涨/拉升",
    user_trade_profit_milestone: "🏆 盈利里程碑",
    user_with_smart_following: "🧠 聪明钱动向",
  };
  return map[type] || type || "交易动态";
}

/* 从嵌套 body 中提取 feed 事件的展示文本 */
function feedBodyText(item) {
  const b = item.body || {};
  if (typeof b === "string") return b;
  const parts = [];

  // 1. 集体买入 / 卖出 人数
  if (Array.isArray(b.users) && b.users.length) {
    parts.push(`${b.users.length} 位大V/交易者集中联动`);
  } else if (b.userCount) {
    parts.push(`${b.userCount} 位交易者联合参与`);
  }

  // 2. 代币及成交额
  if (b.tokenSymbol) parts.push(b.tokenSymbol);
  if (b.amountInUsd !== undefined && b.amountInUsd !== null && Number(b.amountInUsd) > 0) {
    parts.push("总成交 " + fmtUsd(b.amountInUsd));
  } else if (b.totalAmountUsd) {
    parts.push("总额 " + fmtUsd(b.totalAmountUsd));
  }

  // 3. 盈亏与价格
  if (b.pnl !== undefined && b.pnl !== null) {
    const p = Number(b.pnl);
    parts.push("盈亏 " + (p > 0 ? "+" : "") + fmtUsd(p));
  }
  if (b.percentageGain != null) {
    parts.push(`拉升 +${(Number(b.percentageGain) * 100).toFixed(1)}%`);
  }
  if (b.entryPrice) parts.push("入场 " + fmtPrice(b.entryPrice));
  if (b.exitPrice) parts.push("出场 " + fmtPrice(b.exitPrice));
  if (b.price) parts.push("价格 " + fmtPrice(b.price));

  // 4. 自定义留言或观点
  if (b.message || b.comment || b.text) {
    parts.push(b.message || b.comment || b.text);
  }

  const joined = parts.join(" · ");
  return joined || "市场级交易异动";
}

/* 用户钱包地址：完整展示 + 复制按钮
 * prefer：可选，指定优先展示哪个地址（如用户输入的查询地址） */
function addrChip(u, prefer) {
  if (!u) return "";
  let addr = prefer;
  if (!addr || (addr !== u.address && addr !== u.evmAddress)) {
    addr = u.evmAddress || u.address || "";
  }
  if (!addr) return "";
  const chain = addr.startsWith("0x") ? "EVM" : "Solana";
  return `
  <div class="addr-chip">
    <span class="addr-chain">${chain}</span>
    <span class="addr-full" title="${esc(addr)}">${esc(addr)}</span>
    <button class="copy-btn" data-copy="${esc(addr)}" title="复制钱包地址">📋</button>
  </div>`;
}

/* 复制兜底：execCommand（剪贴板 API 不可用时） */
function fallbackCopy(text, ok) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); ok(); } catch (_e) {}
  document.body.removeChild(ta);
}

/* 全局点击复制：任何带 [data-copy] 的元素点击即复制其内容 */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  e.preventDefault();
  const text = btn.getAttribute("data-copy");
  if (!text) return;
  const ok = () => {
    btn.textContent = "✓";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "📋";
      btn.classList.remove("copied");
    }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok).catch(() => fallbackCopy(text, ok));
  } else {
    fallbackCopy(text, ok);
  }
});

/* ================= Top 榜排行标注 ================= */
let __rankMap = null;
let __rankTs = 0;

/* 获取 uid→排行 映射（60 秒缓存；background 无数据时兜底直拉排行榜） */
async function ensureRankMap(force) {
  if (!force && __rankMap && Date.now() - __rankTs < 60000) return __rankMap;
  try {
    const r = await chrome.runtime.sendMessage({ action: "getLbRanks" });
    if (r && r.ok && r.map && Object.keys(r.map).length) {
      __rankMap = r.map;
      __rankTs = Date.now();
      return __rankMap;
    }
  } catch (_e) {}
  try {
    const data = await chrome.runtime.sendMessage({ action: "call", path: "/v2/leaderboard?limit=50", options: {} });
    if (data && data.ok && data.r && data.r.ok) {
      const ro = data.r.data.responseObject || data.r.data || {};
      const lb = ro.leaderboard || [];
      const m = {};
      lb.forEach((u, i) => { if (u && u.id) m[u.id] = i + 1; });
      __rankMap = m;
      __rankTs = Date.now();
      return m;
    }
  } catch (_e) {}
  __rankMap = __rankMap || {};
  return __rankMap;
}

/* 用户排行徽章：返回 " #12" 徽章 HTML，不在榜返回空串 */
function rankBadge(uid) {
  if (!uid || !__rankMap) return "";
  const r = __rankMap[uid];
  return r ? `<span class="rank-badge" title="排行榜第 ${r} 名">#${r}</span>` : "";
}

/* ================= 交易动态统一数据源 =================
 * 所有前端页面拿"跟单信号 / 钱包匹配用户"都走后台统一缓存，
 * 不再各自请求 /feed/tradingActivity（避免 429 限流）。
 */
async function taSignal() {
  try {
    const r = await chrome.runtime.sendMessage({ action: "getTa" });
    if (r && r.ok) return Array.isArray(r.items) ? r.items : [];
  } catch (_e) {}
  return []; // 拿不到缓存就返回空，宁可没数据也不重复打接口触发 429
}

/* ================= 评论翻译 ================= */
const __trCache = new Map();

/* 是否需要翻译：纯中文或纯符号/数字 → false */
function needTranslate(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t || t.length < 3) return false;
  if (/[\u4e00-\u9fff]/.test(t)) return false;        // 已含中文
  return /[A-Za-z]{3,}/.test(t);                       // 含至少 3 个连续字母
}

/* 单条文本翻译（走 background，带缓存） */
async function translateText(text) {
  const t = String(text == null ? "" : text).trim();
  if (!needTranslate(t)) return t;
  if (__trCache.has(t)) return __trCache.get(t);
  let out = t;
  try {
    const r = await chrome.runtime.sendMessage({ action: "translate", text: t });
    if (r && r.ok && r.text && r.text !== t) out = r.text;
  } catch (_e) {}
  __trCache.set(t, out);
  return out;
}

/* 批量翻译并就地渲染：
 * 参数 container：容器元素
 * 参数 map：[[el, text], ...]，为每个 el 在下方插入翻译行
 * 并发限制 6，返回 Promise（所有完成后 resolve） */
async function translateInto(container, map) {
  const jobs = map.map(([el, text]) => ({ el, text }));
  const CONCURRENCY = 6;
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const j = jobs[i++];
      if (!j.el || !needTranslate(j.text)) continue;
      let tr = "";
      const cached = __trCache.get(j.text);
      if (cached) {
        tr = cached;
      } else {
        try {
          const r = await chrome.runtime.sendMessage({ action: "translate", text: j.text });
          if (r && r.ok && r.text && r.text !== j.text) tr = r.text;
        } catch (_e) {}
        if (tr) __trCache.set(j.text, tr);
      }
      if (!tr || tr === j.text) continue;
      // 就地插入翻译行（若已存在则更新）
      let row = container.querySelector(`[data-tr-for="${j.el.dataset.trKey}"]`);
      if (!row) {
        row = document.createElement("div");
        row.className = "d-text-tr";
        row.setAttribute("data-tr-for", j.el.dataset.trKey);
        j.el.parentNode.insertBefore(row, j.el.nextSibling);
      }
      row.textContent = tr;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
}

/* ================= 一键导出真实钱包地址库 =================
 * 数据来源：
 *  ① 预置反查库 __FOMO_DB.users 的 evmReal / solReal（EIP-7702 指纹验证过的真实钱包）
 *     addrMap 中的 real_evm / real_sol 作为兜底
 *  ② 本地收录库 myLib（chrome.storage.local 持久化，用户自定义标签）
 * 导出为 JSON 文件：fomo_real_wallets_YYYY-MM-DD.json
 */
async function collectRealWallets() {
  const rows = new Map(); // addr(lower) -> 记录
  const put = (row) => {
    if (!row || !row.address) return;
    const k = String(row.address).toLowerCase();
    const prev = rows.get(k);
    // mylib（用户自定义标签）优先级高于 db 预置库
    if (!prev || (row.source === "mylib" && prev.source !== "mylib")) rows.set(k, { ...prev, ...row });
  };

  const db = window.__FOMO_DB;
  if (db && Array.isArray(db.users)) {
    for (const u of db.users) {
      const base = {
        uid: u.id, handle: u.handle, displayName: u.displayName,
        followers: u.followers, numTrades: u.numTrades, totalVolume: u.totalVolume,
        conf: u.conf, note: u.note, source: "db",
      };
      if (u.evmReal) put({ ...base, address: u.evmReal, type: "evm", chain: "EVM" });
      if (u.solReal) put({ ...base, address: u.solReal, type: "sol", chain: "Solana" });
    }
  }
  if (db && db.addrMap) {
    for (const [addr, m] of Object.entries(db.addrMap)) {
      if (m.kind === "real_evm" && !rows.has(addr.toLowerCase()))
        put({ address: addr, type: "evm", chain: "EVM", uid: m.uid, source: "db" });
      if (m.kind === "real_sol" && !rows.has(addr.toLowerCase()))
        put({ address: addr, type: "sol", chain: "Solana", uid: m.uid, source: "db" });
    }
  }

  // 本地收录库（用户自定义的真实钱包）
  try {
    const s = await chrome.storage.local.get("fomoMyLib");
    const myLib = Array.isArray(s.fomoMyLib) ? s.fomoMyLib : [];
    for (const it of myLib) {
      const isEVM = /^0x/i.test(it.addr);
      put({
        address: it.addr, type: isEVM ? "evm" : "sol", chain: isEVM ? "EVM" : "Solana",
        label: it.label || "已收录", note: it.note || "", addedAt: it.addedAt, source: "mylib",
      });
    }
  } catch (_e) {}

  // 反查自动收录的真实地址（fomoLookupHits，uid→记录）——视为地址库的一部分
  try {
    const s = await chrome.storage.local.get("fomoLookupHits");
    const map = s.fomoLookupHits || {};
    for (const [uid, h] of Object.entries(map)) {
      if (h && h.evm) put({ address: h.evm, type: "evm", chain: "EVM", uid, handle: h.handle, displayName: h.displayName, note: h.note || "反查收录", source: "db" });
      if (h && h.sol) put({ address: h.sol, type: "sol", chain: "Solana", uid, handle: h.handle, displayName: h.displayName, note: h.note || "反查收录", source: "db" });
    }
  } catch (_e) {}

  const list = Array.from(rows.values());
  list.sort((a, b) => (a.type === b.type ? String(a.address).localeCompare(b.address) : a.type === "evm" ? -1 : 1));
  return list;
}

/* 一键导出：收集全部真实钱包地址，按「完整地址 fomo用户名 [#排名]」每行一条下载 txt，返回导出条数
 * 排名来自排行榜 uid→名次（ensureRankMap，background 缓存）；本地收录无用户信息的显示自定义标签 */
async function exportRealWallets() {
  const wallets = await collectRealWallets();
  let rankMap = {};
  try { rankMap = await ensureRankMap(); } catch (_e) {}
  const lines = wallets.map((w) => {
    const user = w.source === "mylib" ? (w.label || "本地收藏") : ("@" + (w.handle || w.displayName || "未知用户"));
    const rank = w.uid && rankMap[w.uid] ? " #" + rankMap[w.uid] : "";
    return w.address + " " + user + rank;
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fomo_real_wallets_" + new Date().toISOString().slice(0, 10) + ".txt";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  return wallets.length;
}

/* 全局图片加载失败兜底(MV3 CSP 禁止 inline onerror, 这里统一处理) */
document.addEventListener("error", (e) => {
  const t = e.target;
  if (t && t.tagName === "IMG") {
    t.style.visibility = "hidden";
    t.removeAttribute("src");
  }
}, true);
