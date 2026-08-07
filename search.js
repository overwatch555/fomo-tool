/* FOMO 看板 - 搜索模块
 * 支持三种输入：
 *  1) 代币地址(CA)  → 代币概览 + 讨论(thesis) + 谁在买/持有(hodlers)
 *  2) 钱包地址      → 匹配 fomo 用户（基于活跃用户集）
 *  3) 用户名/句柄   → 用户搜索（fuzzy-search）
 */
(() => {
  const $ = (s) => document.querySelector(s);

  async function api(path, options) {
    const r = await chrome.runtime.sendMessage({ action: "call", path, options });
    if (!r || !r.ok) throw new Error(r ? r.error : "无响应");
    if (!r.r.ok) throw new Error("HTTP " + r.r.status);
    return r.r.data;
  }

  /* ---------- 输入识别 ---------- */
  function detectInputType(q) {
    q = q.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(q)) return "evm";            // EVM 地址（钱包或代币）
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) return "sol";  // Solana 地址（钱包或代币）
    if (/^@?[A-Za-z0-9_]{2,30}$/.test(q)) return "handle";      // 用户名
    return "keyword";
  }

  /* ---------- 代币搜索 ---------- */
  /* DexScreener 底池拉取（公开接口，无需鉴权）。
   * FOMO 的 filterTokensSearch 不返回底池明细，这里兜底展示每个交易池。
   * 失败/无数据时静默降级为空数组，不阻塞主信息。 */
  async function fetchPools(addr) {
    if (!addr) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(addr), { signal: ctrl.signal });
      if (!r.ok) return [];
      const d = await r.json();
      const pairs = Array.isArray(d.pairs) ? d.pairs : [];
      const DEX_NAMES = {
        orca: "Orca", valiant: "Valiant", raydium: "Raydium", pumpfun: "Pump.fun",
        uniswap: "Uniswap", pancakeswap: "PancakeSwap", aerodrome: "Aerodrome",
        jupiter: "Jupiter", meteora: "Meteora", whirldex: "Whirl", stoneswap: "StoneSwap",
        bullx: "BullX", photon: "Photon", jupag: "Jup.AG", meteoraCP: "Meteora CP",
      };
      const CHAIN_NAMES = {
        solana: "Solana", ethereum: "Ethereum", bsc: "BSC", base: "Base", x1: "X1",
        ethos: "Ethos", arbitrum: "Arbitrum", polygon: "Polygon", zksync: "zkSync", optimism: "Optimism",
      };
      return pairs
        .filter((p) => p && Number((p.liquidity && p.liquidity.usd) || 0) > 0)
        .map((p) => ({
          pairAddress: p.pairAddress || "",
          dexName: DEX_NAMES[String(p.dexId || "").toLowerCase()] || (p.dexId || "DEX"),
          chain: CHAIN_NAMES[String(p.chainId || "").toLowerCase()] || (p.chainId || ""),
          baseSymbol: (p.baseToken && p.baseToken.symbol) || "?",
          quoteSymbol: (p.quoteToken && p.quoteToken.symbol) || "?",
          liquidity: (p.liquidity && p.liquidity.usd) || 0,
          volume24: (p.volume && p.volume.h24) || 0,
          priceChange24: (p.priceChange && p.priceChange.h24) || 0,
          txns5mBuys: (p.txns && p.txns.m5 && p.txns.m5.buys) || 0,
          txns5mSells: (p.txns && p.txns.m5 && p.txns.m5.sells) || 0,
          fdv: p.fdv || 0,
          marketCap: p.marketCap || 0,
        }))
        .sort((a, b) => b.liquidity - a.liquidity);
    } catch (_e) {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function searchToken(q) {
    // 1. 识别代币（按地址/短语）
    const res = await api("/proxy/filterTokensSearch", { method: "POST", body: { phrase: q } });
    const tokens = res.responseObject || [];
    if (!tokens.length) return null;
    const t = tokens[0];
    const tok = t.token || {};
    const nid = tok.networkId;
    const addr = tok.address || q;

    // 2. 并行拉取讨论、持有者、单币动态 + DexScreener 底池
    const [thesis, holders, tfeed, pools] = await Promise.all([
      api("/feed/token/thesis", { params: { tokenAddress: addr, networkId: nid, threshold: 0 } }).catch(() => null),
      api("/hodlers/top?tokens=" + encodeURIComponent(JSON.stringify([{ address: addr, networkId: nid }]))).catch(() => null),
      api("/feed/token", { params: { tokenAddress: addr, networkId: nid, excludeThesis: "true", threshold: 0 } }).catch(() => null),
      fetchPools(addr).catch(() => []),
    ]);
    return {
      token: t,
      thesis: thesis && thesis.responseObject ? thesis.responseObject.items || [] : [],
      holders: holders && holders.responseObject ? holders.responseObject : [],
      feed: tfeed && tfeed.responseObject ? tfeed.responseObject.feed || [] : [],
      pools: pools || [],
    };
  }

  /* ---------- 钱包匹配 ---------- */
  async function matchWallet(addr) {
    const norm = addr.toLowerCase();
    const isEVM = norm.startsWith("0x");
    const idx = new Map(); // addr(lower) -> user
    const seen = new Set();

    const addUser = (u) => {
      if (!u) return;
      const key = u.id || u.userHandle;
      if (seen.has(key)) return;
      seen.add(key);
      if (u.address) idx.set(u.address.toLowerCase(), u);
      if (u.evmAddress) idx.set(u.evmAddress.toLowerCase(), u);
    };

    // 数据源1：排行榜（all-time + 24h + 7d + 30d）
    const periods = [
      ["/v2/leaderboard?limit=100", "all"],
      ["/v2/leaderboard/24h?limit=50", "24h"],
      ["/v2/leaderboard/7d?limit=50", "7d"],
      ["/v2/leaderboard/30d?limit=50", "30d"],
    ];
    for (const [path] of periods) {
      try {
        const d = await api(path);
        const lb = d.responseObject && d.responseObject.leaderboard || [];
        lb.forEach(addUser);
      } catch (_e) {}
    }

    // 数据源2：近期交易动态里的用户（走后台统一缓存，避免 429）
    try {
      const items = await taSignal();
      items.forEach((s) => addUser(s.user || (s.userId && s)));
    } catch (_e) {}

    const hit = idx.get(norm);

    // 增强：地址索引反查（包含浏览过用户的 绑定地址 + 交易实际执行地址/链上转账地址）
    let indexHit = null;
    if (!hit && window.__addrIndex) {
      const entry = window.__addrIndex.get(norm);
      if (entry) {
        const u = window.__userCache.get(entry.uid) || null;
        indexHit = { user: u, uid: entry.uid, via: entry.via, addr: entry.addr, networkId: entry.networkId, displayName: entry.displayName, userHandle: entry.userHandle };
      }
    }
    return { hit: hit || null, scanned: seen.size, indexHit };
  }

  /* ---------- 用户名搜索 ---------- */
  async function searchHandle(q) {
    const d = await api("/v2/users/fuzzy-search?searchTerm=" + encodeURIComponent(q.replace(/^@/, "")));
    return d.responseObject && d.responseObject.users || [];
  }

  /* ---------- 渲染：代币（各模块独立构建，供整体渲染 + 分模块实时刷新共用） ---------- */
  /* 代币概览卡 */
  function overviewHTML(t) {
    const tok = t.token || {};
    const img = (tok.info && (tok.info.imageLargeUrl || tok.info.imageSmallUrl)) || "";
    const c24 = Number(t.change24 || 0);
    const c1 = Number(t.change1 || 0);
    const b24 = Number(t.buyCount24 || 0), s24 = Number(t.sellCount24 || 0);
    const ratio = s24 > 0 ? (b24 / s24).toFixed(2) : (b24 > 0 ? "∞" : "-");
    return `
    <div class="token-overview">
      <div class="t-head">
        <img src="${esc(img)}">
        <div class="t-id">
          <div class="t-name">${esc(tok.name || "未知代币")} <span class="t-sym-pill">${esc(tok.symbol || "")}</span></div>
          <div class="t-sub">${esc(chainName(tok.networkId))} · <span class="t-addr">${esc(shortAddr(tok.address, 8))}</span></div>
        </div>
        <div class="t-pricebox">
          <div class="t-price">${fmtPrice(Number(t.priceUSD))}</div>
          <div class="t-chg ${pctClass(c24)}">${c24 > 0 ? "▲" : c24 < 0 ? "▼" : "—"} ${fmtPct(c24)}<span>24h</span></div>
        </div>
      </div>
      <div class="t-grid">
        <div class="t-item"><div class="k">市值</div><div class="v">${fmtUsd(Number(t.marketCap))}</div></div>
        <div class="t-item"><div class="k">24h成交额</div><div class="v">${fmtUsd(Number(t.volume24))}</div></div>
        <div class="t-item"><div class="k">持有人</div><div class="v">${fmtNum(t.holders, 0)}</div></div>
        <div class="t-item"><div class="k">买卖比24h</div><div class="v">${ratio}</div></div>
        <div class="t-item"><div class="k">流动性</div><div class="v">${fmtUsd(Number(t.liquidity))}</div></div>
        <div class="t-item"><div class="k">1h涨跌</div><div class="v ${pctClass(c1)}">${fmtPct(c1)}</div></div>
      </div>
    </div>`;
  }

  /* 底池信息（DexScreener 兜底，按流动性排序，主力池高亮） */
  function poolsHTML(pools) {
    pools = pools || [];
    if (!pools.length) return "";
    let html = `<div class="sec-title"><span class="bar"></span>💧 底池信息<span class="sec-count">${pools.length} 个池子</span></div>`;
    html += pools.slice(0, 6).map((p, pi) => {
      const mainCls = pi === 0 ? " pool-main" : "";
      const liq = Number(p.liquidity) || 0;
      const vol = Number(p.volume24) || 0;
      const chg = Number(p.priceChange24) || 0;
      const m5 = `${fmtNum(p.txns5mBuys, 0)}/${fmtNum(p.txns5mSells, 0)}`;
      const volLine = vol > 0 ? `<span>24h 成交 <b>${fmtUsd(vol)}</b></span>` : "";
      const chgLine = chg !== 0 ? `<span class="${pctClass(chg)}">24h ${fmtPct(chg)}</span>` : "";
      const fdvLine = p.fdv > 0 ? `<span>FDV ${fmtUsd(p.fdv)}</span>` : "";
      return `
      <div class="pool-card${mainCls}">
        <div class="p-row1">
          <span class="p-dex">${esc(p.dexName)}</span>
          <span class="p-pair">${esc(p.baseSymbol)}/${esc(p.quoteSymbol)}</span>
          <span class="p-chain">${esc(p.chain)}</span>
          <span class="p-liq">💵 ${fmtUsd(liq)}</span>
        </div>
        <div class="p-row2">${volLine}${chgLine}${fdvLine}<span>5m 买/卖 <b>${m5}</b></span></div>
      </div>`;
    }).join("");
    return html;
  }

  /* 讨论区（thesis） */
  function thesisHTML(thesis, trList) {
    thesis = thesis || [];
    let html = `<div class="sec-title"><span class="bar"></span>💬 大家怎么说<span class="sec-count">${thesis.length}</span></div>`;
    if (thesis.length) {
      if (window.__fomoUser) thesis.forEach((it) => it.userId && window.__fomoUser.indexUser({
        id: it.userId, displayName: it.displayName, userHandle: it.userHandle,
        profilePictureLink: it.profilePictureLink, networkId: it.networkId,
      }));
      thesis.slice(0, 15).forEach((it, ti) => {
        const c = it.comment && it.comment.comment || "";
        const at = it.authorTrade || {};
        const upnl = Number(at.unrealizedPnlUsd || 0);
        const rpnl = Number(at.realizedPnlUsd || 0);
        if (c) trList.push({ key: "t" + ti, text: c });
        const holdChip = at.humanTokenAmount
          ? `<span class="d-hold-chip" title="作者当前持仓">📦 持仓 <b>${fmtAmount(at.humanTokenAmount)} ${esc(it.ticker || "")}</b>${at.usdValue ? `<em>${fmtUsd(at.usdValue)}</em>` : ""}</span>` : "";
        const upnlChip = upnl !== 0 ? `<span class="d-pnl-chip ${pctClass(upnl)}">${upnl > 0 ? "▲" : "▼"} 浮盈 ${upnl > 0 ? "+" : ""}${fmtUsd(upnl)}</span>` : "";
        const rpnlChip = rpnl !== 0 ? `<span class="d-pnl-chip ${pctClass(rpnl)}">${rpnl > 0 ? "▲" : "▼"} 已实现 ${rpnl > 0 ? "+" : ""}${fmtUsd(rpnl)}</span>` : "";
        const thrChip = it.threshold > 0 ? `<span class="d-tag">🎯 门槛 ${fmtUsd(it.threshold)}</span>` : "";
        html += `
        <div class="discuss-card clickable-user" data-uid="${esc(it.userId)}" title="点击查看用户详情">
          <div class="d-top">
            ${it.profilePictureLink ? `<img src="${esc(it.profilePictureLink)}">` : `<div class="avatar">F</div>`}
            <div class="d-id">
              <div class="d-name">${esc(it.displayName || "匿名")}${rankBadge(it.userId)}</div>
              <div class="d-handle">@${esc(it.userHandle || "")}</div>
            </div>
            <div class="d-time">${timeAgo(it.createdAt)}</div>
          </div>
          <div class="d-text" data-tr-key="t${ti}">${esc(c)}</div>
          ${(holdChip || upnlChip || rpnlChip || thrChip) ? `<div class="d-meta">${holdChip}${upnlChip}${rpnlChip}${thrChip}</div>` : ""}
        </div>`;
      });
    } else {
      html += `<div class="no-result">暂无讨论（可能还没人发观点，或该代币较冷门）</div>`;
    }
    return html;
  }

  /* 谁在买/持有（标题 + 卡片分拆，刷新时只换卡片、不动按钮与面板） */
  function holdersTitleHTML(totalHolders, count) {
    return `<div class="sec-title"><span class="bar"></span>👥 Top 持有者<span class="sec-count">${count}</span>${totalHolders ? `<span class="sec-sub">总持有 ${fmtNum(totalHolders, 0)} 人</span>` : ""}<span class="sec-right"><button class="reveal-all-btn" data-reveal-all title="按持仓金额/成本/排名筛选后批量反推真实链上钱包">⚡ 一键反推</button></span></div>`;
  }
  function holdersCardsHTML(holders) {
    holders = holders || [];
    // 记录当前持有者上下文（供批量反推使用，不改变任何卡片布局）
    __holderCtx = holders.map((h, hi) => ({ h, rank: hi + 1 }));
    if (!holders.length) return `<div class="no-result">暂无持有者数据</div>`;
    if (window.__fomoUser) holders.forEach((h) => h.user && window.__fomoUser.indexUser(h.user));
    // 持仓大小(优先市值, 兜底数量) → 按最大者归一化为横向对比条
    const sizeOf = (h) => {
      const v = Math.abs(Number(h.value) || 0);
      return v > 0 ? v : Math.abs(Number(h.humanAmount) || 0);
    };
    const maxSize = Math.max(0, ...holders.map(sizeOf));
    return holders.map((h, hi) => {
      const u = h.user || {};
      const amt = h.humanAmount;
      const val = Number(h.value) || 0;
      const pnl = Number(h.pnl) || 0;
      const barW = maxSize > 0 ? Math.max(5, (sizeOf(h) / maxSize) * 100) : 0;
      const top = hi === 0 ? " top1" : hi === 1 ? " top2" : hi === 2 ? " top3" : "";
      return `
      <div class="holder-card clickable-user${top}" data-uid="${esc(u.id)}" title="点击查看用户详情">
        <div class="h-rank${top}">${hi + 1}</div>
        ${u.profilePictureLink ? `<img src="${esc(u.profilePictureLink)}">` : `<div class="avatar">F</div>`}
        <div class="h-main">
          <div class="h-top">
            <div class="h-name">${esc(u.displayName || "未命名")}${rankBadge(u.id)}</div>
            <div class="h-handle">@${esc(u.userHandle || "")}</div>
          </div>
          <div class="h-bar" title="持仓规模（相对第 1 名）"><i style="width:${barW}%"></i></div>
          ${addrChip(u)}
        </div>
        <div class="h-right">
          ${amt !== undefined ? `<div class="h-amt">${fmtAmount(amt)} 枚</div>` : ""}
          ${val ? `<div class="h-val">≈ ${fmtUsd(val)}</div>` : ""}
          ${pnl !== 0 ? `<div class="h-pnl ${pctClass(pnl)}">${pnl > 0 ? "+" : ""}${fmtUsd(pnl)}</div>` : ""}
        </div>
      </div>`;
    }).join("");
  }
  function holdersSectionHTML(holders, totalHolders) {
    return holdersTitleHTML(totalHolders, (holders || []).length) + holdersCardsHTML(holders);
  }

  /* 单币动态 */
  function feedHTML(feed, trList) {
    feed = feed || [];
    if (!feed.length) return "";
    let html = `<div class="sec-title"><span class="bar"></span>📈 最近动态<span class="sec-count">${feed.length}</span></div>`;
    feed.slice(0, 8).forEach((f, fi) => {
      const c = f.comment && f.comment.comment || "";
      const bodyTxt = f.body && feedBodyText(f) || "";
      if (c) trList.push({ key: "f" + fi, text: c });
      html += `
      <div class="discuss-card">
        <div class="d-top">
          ${f.profilePictureLink ? `<img src="${esc(f.profilePictureLink)}">` : `<div class="avatar">F</div>`}
          <div>
            <div class="d-name">${esc(f.displayName || "匿名")}</div>
            <div class="d-handle">@${esc(f.userHandle || "")}</div>
          </div>
          <div class="d-time">${timeAgo(f.createdAt)}</div>
        </div>
        <div class="d-text" data-tr-key="f${fi}">${esc(c || bodyTxt) || '<span class="muted">交易动态</span>'}</div>
      </div>`;
    });
    return html;
  }

  /* 整体渲染：概览 → 底池 → 讨论 → 持有者 → 动态 */
  function renderToken(result, q) {
    const trList = []; // 待翻译的评论 [{ key, text }]
    const t = result.token;
    const holders = (result.holders[0] && result.holders[0].topHolders) || [];
    const totalHolders = result.holders[0] ? result.holders[0].totalHolders : 0;
    let html = overviewHTML(t);
    html += poolsHTML(result.pools || []);
    html += thesisHTML(result.thesis || [], trList);
    html += holdersSectionHTML(holders, totalHolders);
    html += feedHTML(result.feed || [], trList);
    return { html, trList };
  }

  /* ---------- 分模块实时刷新（不整体重建，互不干扰，反推流程不受影响） ---------- */
  let __currentToken = null;   // { q, addr, nid } 当前展示的代币
  let __refreshTimer = null;   // 定时器句柄
  let __refreshBusy = false;   // 防重入
  const REFRESH_MS = 30000;    // 30s 轮询一次

  /* 找到某模块（按 sec-title 文案）的标题节点与其间的模块节点
   * - 向后跳过连续的同名标题（历史重复残留，刷新时一次性合并清理）
   * - 反推面板是独立挂载的：遇到面板即停止收集，面板作为插入锚点 */
  function sectionRange(content, marker) {
    const titles = Array.from(content.querySelectorAll(".sec-title"));
    let idx = titles.findIndex((t) => t.textContent.includes(marker));
    if (idx < 0) return null;
    const start = titles[idx];
    let j = idx + 1;
    while (j < titles.length && titles[j].textContent.includes(marker)) j++;
    const end = titles[j] || null;
    const nodes = [];   // 属于本模块、需要移除的节点（含重复残留）
    let anchor = end;   // 新内容插入到 anchor 之前
    let n = start.nextSibling;
    while (n && n !== end) {
      const next = n.nextSibling;
      if (n.nodeType === 1) {
        if (n.classList.contains("reveal-panel")) { anchor = n; break; }
        nodes.push(n);
      }
      n = next;
    }
    return { start, anchor, nodes };
  }

  /* 用 html 替换某模块区域（旧标题 + 旧内容整体移除，只留一份新的）；
   * html 为空时整块移除（含标题） */
  function replaceSection(content, marker, html) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html || "";
    const frag = document.createDocumentFragment();
    while (wrap.firstChild) frag.appendChild(wrap.firstChild);
    const range = sectionRange(content, marker);
    if (!range) {
      if (frag.childNodes.length) content.appendChild(frag);
      return;
    }
    range.nodes.forEach((n) => n.remove());
    range.start.remove();
    if (frag.childNodes.length) {
      if (range.anchor) range.anchor.parentNode.insertBefore(frag, range.anchor);
      else content.appendChild(frag);
    }
  }

  /* 新渲染的评论就地翻译 */
  function translateSection(content, trList) {
    if (!trList || !trList.length) return;
    const map = trList.map(({ key, text }) => {
      const el = content.querySelector(`[data-tr-key="${key}"]`);
      return [el, text];
    }).filter(([el]) => el);
    if (map.length && window.translateInto) translateInto(content, map);
  }

  /* 模块① 代币概览（价格/市值/成交额等，只换概览卡） */
  async function refreshOverview() {
    const t = __currentToken;
    if (!t) return;
    try {
      const res = await api("/proxy/filterTokensSearch", { method: "POST", body: { phrase: t.addr } });
      const tokens = (res && res.responseObject) || [];
      if (!tokens.length) return;
      const content = $("#srContent");
      const old = content && content.querySelector(".token-overview");
      if (!old) return;
      const fresh = htmlToEl(overviewHTML(tokens[0]));
      old.replaceWith(fresh);
    } catch (_e) {}
  }

  /* 模块② 底池信息（有则换，无数据则整块移除；原来没有则插到概览卡后） */
  async function refreshPools() {
    const t = __currentToken;
    if (!t) return;
    try {
      const pools = await fetchPools(t.addr);
      const content = $("#srContent");
      if (!content) return;
      const html = poolsHTML(pools);
      const range = sectionRange(content, "底池信息");
      if (range) {
        replaceSection(content, "底池信息", html);
      } else if (html) {
        const ov = content.querySelector(".token-overview");
        const wrap = document.createElement("div");
        wrap.innerHTML = html;
        const frag = document.createDocumentFragment();
        while (wrap.firstChild) frag.appendChild(wrap.firstChild);
        const ref = ov || content;
        ref.parentNode.insertBefore(frag, ref.nextSibling);
      }
    } catch (_e) {}
  }

  /* 模块③ 大家怎么说（thesis） */
  async function refreshThesis() {
    const t = __currentToken;
    if (!t) return;
    try {
      const d = await api("/feed/token/thesis", { params: { tokenAddress: t.addr, networkId: t.nid, threshold: 0 } });
      const items = (d && d.responseObject && d.responseObject.items) || [];
      const trList = [];
      const content = $("#srContent");
      if (!content) return;
      replaceSection(content, "大家怎么说", thesisHTML(items, trList));
      translateSection(content, trList);
    } catch (_e) {}
  }

  /* 模块④ Top 持有者（反推进行中/面板打开时跳过，绝不打断反推） */
  async function refreshHolders() {
    const t = __currentToken;
    if (!t || __revealRunning) return;
    const content = $("#srContent");
    if (!content) return;
    if (content.querySelector(".reveal-panel")) return; // 面板打开时不打扰
    try {
      const d = await api("/hodlers/top?tokens=" + encodeURIComponent(JSON.stringify([{ address: t.addr, networkId: t.nid }])));
      const first = (d && d.responseObject && d.responseObject[0]) || null;
      const newHolders = (first && first.topHolders) || [];
      const range = sectionRange(content, "Top 持有者");
      if (!range) return;
      // 只更新标题计数 + 卡片，保留 ⚡ 一键反推 按钮与面板
      const countEl = range.start.querySelector(".sec-count");
      if (countEl) countEl.textContent = newHolders.length;
      const subEl = range.start.querySelector(".sec-sub");
      if (subEl) subEl.textContent = first && first.totalHolders ? `总持有 ${fmtNum(first.totalHolders, 0)} 人` : "";
      const wrap = document.createElement("div");
      wrap.innerHTML = holdersCardsHTML(newHolders); // 内部会同步 __holderCtx
      const frag = document.createDocumentFragment();
      while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      range.nodes.forEach((n) => n.remove());
      if (frag.childNodes.length) range.start.parentNode.insertBefore(frag, range.anchor);
    } catch (_e) {}
  }

  /* 模块⑤ 最近动态（feed） */
  async function refreshFeed() {
    const t = __currentToken;
    if (!t) return;
    try {
      const d = await api("/feed/token", { params: { tokenAddress: t.addr, networkId: t.nid, excludeThesis: "true", threshold: 0 } });
      const items = (d && d.responseObject && d.responseObject.feed) || [];
      const trList = [];
      const content = $("#srContent");
      if (!content) return;
      replaceSection(content, "最近动态", feedHTML(items, trList));
      translateSection(content, trList);
    } catch (_e) {}
  }

  /* 每轮刷新：各模块独立拉取、独立失败，互不影响 */
  async function refreshTokenModules() {
    if (__refreshBusy) return;
    const view = $("#searchResult");
    if (!view || view.style.display === "none") return;
    if (!__currentToken) return;
    if (typeof document.visibilityState === "string" && document.visibilityState === "hidden") return;
    __refreshBusy = true;
    try {
      await Promise.allSettled([
        refreshOverview(),
        refreshThesis(),
        refreshFeed(),
        refreshPools(),
        refreshHolders(),
      ]);
      const live = $("#srLive");
      if (live) live.textContent = `✓ ${new Date().toLocaleTimeString([], { hour12: false })} 已更新`;
    } catch (_e) {} finally {
      __refreshBusy = false;
    }
  }

  function startTokenRefresh() {
    if (__refreshTimer) clearInterval(__refreshTimer);
    const live = $("#srLive");
    if (live) { live.style.display = ""; live.textContent = "🔄 30s 自动刷新"; }
    __refreshTimer = setInterval(() => { refreshTokenModules(); }, REFRESH_MS);
  }
  function stopTokenRefresh() {
    if (__refreshTimer) clearInterval(__refreshTimer);
    __refreshTimer = null;
    __currentToken = null;
    const live = $("#srLive");
    if (live) live.style.display = "none";
  }

  /* ---------- 持有者真实地址反推（一键） ---------- */
  const EXPLORERS = {
    1: "https://etherscan.io/address/",
    56: "https://bscscan.com/address/",
    8453: "https://basescan.org/address/",
    4663: "https://robinhoodchain.blockscout.com/address/",
    1399811149: "https://solscan.io/account/",
  };

  /* 已反查持有者：返回真实钱包徽章数组（EVM / SOL） */
  function holderRevealBadges(u) {
    const parts = [];
    if (u && u._evmReal) parts.push(`<span class="fp-badge fp-real" title="已反查：真实 EVM 钱包">✅ EVM ${shortAddr(u._evmReal, 6)}</span>`);
    if (u && u._solReal) parts.push(`<span class="fp-badge fp-real" title="已反查：真实 Solana 钱包">✅ SOL ${shortAddr(u._solReal, 6)}</span>`);
    return parts;
  }

  /* ---------- 一键批量反推（不改变原布局，独立面板） ---------- */
  let __holderCtx = [];    // 当前代币的持有者上下文 [{h, rank}]
  let __revealRunning = false;

  /* 持有者估算成本：当前市值 - 未实现盈亏 ≈ 买入成本（算不出返回 null） */
  function costOf(h) {
    const v = Number(h.value);
    if (isNaN(v) || !isFinite(v)) return null;
    const pnl = Number(h.pnl);
    return !isNaN(pnl) && isFinite(pnl) ? v - pnl : null;
  }

  /* 按筛选条件过滤持有者（持仓排名 / 持仓金额 / 持仓数量 / 持仓成本） */
  function filterHolders(ctx, f) {
    return ctx.filter(({ h, rank }) => {
      const val = Number(h.value) || 0;
      const amt = Number(h.humanAmount) || 0;
      const cost = costOf(h);
      if (f.rank > 0 && rank > f.rank) return false;
      if (f.value > 0 && val < f.value) return false;
      if (f.amount > 0 && amt < f.amount) return false;
      if (f.cost > 0 && (cost == null || cost < f.cost)) return false;
      return true;
    });
  }

  /* 单行结果：排名 + 名字 + 真实地址（复制/链上链接） */
  function revealRowHTML(item, res, errMsg) {
    const u = item.h.user || {};
    const name = esc(u.displayName || u.userHandle || "匿名");
    let addrHTML = "";
    if (errMsg) {
      addrHTML = `<span class="reveal-err">⚠ ${errMsg}</span>`;
    } else if (res && res.hasSwaps) {
      const evm = res.evm, sol = res.sol;
      if (evm && evm.address) {
        const ex = EXPLORERS[res.mainEvmChain] ? EXPLORERS[res.mainEvmChain] + evm.address : "";
        addrHTML += `<span class="fp-badge fp-real">EVM ${shortAddr(evm.address, 6)}</span><button class="copy-btn" data-copy="${esc(evm.address)}" title="复制">📋</button>${ex ? `<a href="${ex}" target="_blank" rel="noopener">链上↗</a>` : ""}`;
      }
      if (sol && sol.address) {
        const ex = EXPLORERS[1399811149] + sol.address;
        addrHTML += `<span class="fp-badge fp-real">SOL ${shortAddr(sol.address, 6)}</span><button class="copy-btn" data-copy="${esc(sol.address)}" title="复制">📋</button>${ex ? `<a href="${ex}" target="_blank" rel="noopener">链上↗</a>` : ""}`;
      }
      if (!addrHTML) addrHTML = `<span class="reveal-empty">未找到真实地址</span>`;
    } else {
      addrHTML = `<span class="reveal-empty">链上无 Swap 记录，无法反推</span>`;
    }
    return `<div class="reveal-row"><span class="reveal-rank">#${item.rank}</span><span class="reveal-name">${name}</span><span class="reveal-addrs">${addrHTML}</span></div>`;
  }

  function htmlToEl(html) {
    const t = document.createElement("div");
    t.innerHTML = html;
    return t.firstElementChild;
  }

  function readFilters(panel) {
    return {
      rank: Math.max(0, Number(panel.querySelector("#rfRank").value) || 0),
      value: Math.max(0, Number(panel.querySelector("#rfValue").value) || 0),
      amount: Math.max(0, Number(panel.querySelector("#rfAmount").value) || 0),
      cost: Math.max(0, Number(panel.querySelector("#rfCost").value) || 0),
    };
  }

  /* 批量反推主流程：逐个调用 lookup 引擎，命中自动收录 */
  async function runBatchReveal(panel) {
    if (__revealRunning || !window.__lookup) return;
    const targets = filterHolders(__holderCtx, readFilters(panel));
    const resultsEl = panel.querySelector(".reveal-results");
    if (!targets.length) {
      resultsEl.innerHTML = `<div class="reveal-empty">没有持有者符合筛选条件</div>`;
      return;
    }
    __revealRunning = true;
    const startBtn = panel.querySelector("#rfStart");
    const prog = panel.querySelector(".reveal-progress");
    const progBar = panel.querySelector(".reveal-progress-bar .fill");
    const progText = panel.querySelector(".reveal-progress-text");
    startBtn.disabled = true;
    startBtn.textContent = "反推中…";
    prog.style.display = "block";
    resultsEl.innerHTML = "";
    let hitCount = 0;
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      const u = item.h.user || {};
      progBar.style.width = Math.round((i / targets.length) * 100) + "%";
      progText.textContent = `${i + 1}/${targets.length}：反推 #${item.rank} ${u.displayName || u.userHandle || "匿名"}…`;
      try {
        const res = await window.__lookup.startLookup(u.id, () => {});
        let saved = 0;
        if (res.evm && res.evm.address && window.__fomoUser && window.__fomoUser.saveLookupHit) {
          try { await window.__fomoUser.saveLookupHit(u.id, { displayName: u.displayName || "", handle: u.userHandle || "", evm: res.evm.address, evmChainId: res.mainEvmChain }); saved++; } catch (_e) {}
        }
        if (res.sol && res.sol.address && window.__fomoUser && window.__fomoUser.saveLookupHit) {
          try { await window.__fomoUser.saveLookupHit(u.id, { displayName: u.displayName || "", handle: u.userHandle || "", sol: res.sol.address }); saved++; } catch (_e) {}
        }
        if (saved) hitCount++;
        resultsEl.appendChild(htmlToEl(revealRowHTML(item, res)));
      } catch (e) {
        resultsEl.appendChild(htmlToEl(revealRowHTML(item, null, String(e).slice(0, 80))));
      }
    }
    progBar.style.width = "100%";
    progText.textContent = `✅ 完成：共反推 ${targets.length} 人，命中 ${hitCount} 个真实地址（已自动收录到地址库）`;
    startBtn.disabled = false;
    startBtn.textContent = "🔄 再反推一次";
    __revealRunning = false;
  }

  /* 构建筛选面板 */
  function buildRevealPanel() {
    const div = document.createElement("div");
    div.className = "reveal-panel";
    div.innerHTML = `
      <div class="reveal-panel-head">🔍 批量反推真实地址
        <span class="reveal-panel-sub">按条件筛选持有者后逐个反推链上真实钱包，命中自动收录</span>
      </div>
      <div class="reveal-filters">
        <label>持仓排名 Top <input id="rfRank" type="number" min="0" value="20"></label>
        <label>持仓金额 ≥ <input id="rfValue" type="number" min="0" placeholder="$"></label>
        <label>持仓数量 ≥ <input id="rfAmount" type="number" min="0" placeholder="枚"></label>
        <label>持仓成本 ≥ <input id="rfCost" type="number" min="0" placeholder="$"></label>
      </div>
      <div class="reveal-actions">
        <button id="rfStart" class="rf-btn rf-primary">🚀 开始反推</button>
        <button id="rfClose" class="rf-btn">收起</button>
        <span class="reveal-count" id="rfCount"></span>
      </div>
      <div class="reveal-progress" style="display:none"><div class="reveal-progress-bar"><div class="fill" style="width:0%"></div></div><div class="reveal-progress-text"></div></div>
      <div class="reveal-results"></div>`;
    const recount = () => {
      const n = filterHolders(__holderCtx, readFilters(div)).length;
      div.querySelector("#rfCount").textContent = `符合条件 ${n} 人 / 共 ${__holderCtx.length} 人`;
    };
    ["#rfRank", "#rfValue", "#rfAmount", "#rfCost"].forEach((sel) => div.querySelector(sel).addEventListener("input", recount));
    div.querySelector("#rfStart").addEventListener("click", () => runBatchReveal(div));
    div.querySelector("#rfClose").addEventListener("click", () => div.remove());
    recount();
    return div;
  }

  /* 总按钮事件委托：面板紧跟持有者标题栏（按钮正下方），不用下拉 */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-reveal-all]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (__revealRunning) return;
    if (!window.__lookup) { btn.textContent = "反查引擎未加载"; return; }
    if (!__holderCtx.length) { btn.textContent = "暂无可反推持有者"; return; }
    const content = $("#srContent");
    if (!content) return;
    const existing = content.querySelector(".reveal-panel");
    if (existing) { existing.remove(); return; } // 再点收起
    const panel = buildRevealPanel();
    const holderTitle = Array.from(content.querySelectorAll(".sec-title")).find((t) => t.textContent.includes("Top 持有者"));
    if (holderTitle) holderTitle.insertAdjacentElement("afterend", panel); // 紧跟标题栏 = 按钮正下方
    else content.appendChild(panel);
  });

  /* ---------- 渲染：钱包匹配 ---------- */
  function renderWallet(hit, q, scanned, indexHit) {
    // 索引反查命中（地址曾在某用户的交易中出现）
    if (!hit && indexHit) {
      const u = indexHit.user;
      const viaLabel = indexHit.via === "swap" ? "Swap 实际执行地址" : indexHit.via === "transfer" ? "链上转账地址" : indexHit.via === "trade" ? "交易账户地址" : indexHit.via === "real" ? "地址库反查真实钱包" : "绑定钱包地址";
      const body = u ? `
        <div class="wallet-user clickable-user" data-uid="${esc(u.id)}" title="点击查看用户详情">
          ${u.profilePictureLink ? `<img src="${esc(u.profilePictureLink)}">` : `<div class="avatar">F</div>`}
          <div>
            <div class="w-name" style="font-size:17px">${esc(u.displayName || "未命名")}</div>
            <div class="w-handle">@${esc(u.userHandle || "")}</div>
            <div class="w-stats">
              <span>粉丝 <b>${fmtNum(u.followers, 0)}</b></span>
              <span>交易 <b>${fmtNum(u.numTrades, 0)}</b> 笔</span>
              ${u.totalVolume ? `<span>总交易额 <b>${fmtUsd(u.totalVolume)}</b></span>` : ""}
            </div>
            ${addrChip(u, q.trim())}
          </div>
        </div>` : `
        <div class="wallet-user">
          <div class="avatar">F</div>
          <div>
            <div class="w-name">${esc(indexHit.displayName || "未命名")}</div>
            <div class="w-handle">@${esc(indexHit.userHandle || "")}</div>
          </div>
        </div>`;
      return `
        <div class="match-scope">🎯 地址反查命中：该地址在 FOMO 上是 <b>${esc((u && u.displayName) || indexHit.displayName)}</b> 的${viaLabel}（${esc(chainName(indexHit.networkId))}）。点击卡片查看完整详情。</div>
        ${body}`;
    }
    if (!hit) {
      return `
        <div class="match-scope">未能在 FOMO 活跃用户集中匹配到该钱包地址。
        已扫描 ${scanned} 个活跃用户（排行榜各周期 Top + 近期交易者）。
        注意：FOMO 未提供全量用户列表接口，此结果不代表该地址未注册 FOMO，仅表示不在近期活跃范围内。</div>
        <div class="no-result">未匹配到 FOMO 用户</div>`;
    }
    const u = hit;
    return `
      <div class="match-scope">✅ 匹配成功！已扫描 ${scanned} 个活跃用户。</div>
      <div class="wallet-user clickable-user" data-uid="${esc(u.id)}" title="点击查看用户详情" style="padding:18px 22px">
        ${u.profilePictureLink ? `<img src="${esc(u.profilePictureLink)}">` : `<div class="avatar">F</div>`}
        <div>
          <div class="w-name" style="font-size:17px">${esc(u.displayName || "未命名")}</div>
          <div class="w-handle">@${esc(u.userHandle || "")}</div>
          <div class="w-stats">
            <span>粉丝 <b>${fmtNum(u.followers, 0)}</b></span>
            <span>交易 <b>${fmtNum(u.numTrades, 0)}</b> 笔</span>
            ${u.totalVolume ? `<span>总交易额 <b>${fmtUsd(u.totalVolume)}</b></span>` : ""}
            ${u.pnl24h !== undefined ? `<span>24h盈亏 <b class="${pctClass(u.pnl24h)}">${u.pnl24h > 0 ? "+" : ""}${fmtUsd(u.pnl24h)}</b></span>` : ""}
          </div>
          ${addrChip(u, q.trim())}
        </div>
      </div>`;
  }

  /* ---------- 渲染：用户名 ---------- */
  function renderUsers(users) {
    if (!users.length) return `<div class="no-result">未找到匹配的用户</div>`;
    if (window.__fomoUser) users.forEach((u) => window.__fomoUser.indexUser(u));
    return users.map((u) => `
      <div class="wallet-user clickable-user" data-uid="${esc(u.id)}" title="点击查看用户详情">
        ${u.profilePictureLink ? `<img src="${esc(u.profilePictureLink)}">` : `<div class="avatar">F</div>`}
        <div>
          <div class="w-name">${esc(u.displayName || "未命名")}</div>
          <div class="w-handle">@${esc(u.userHandle || "")} · ${esc(chainName(u.networkId)) || ""}</div>
          <div class="w-stats">
            ${u.followers !== undefined ? `<span>粉丝 <b>${fmtNum(u.followers, 0)}</b></span>` : ""}
            ${u.numTrades !== undefined ? `<span>交易 <b>${fmtNum(u.numTrades, 0)}</b></span>` : ""}
          </div>
          ${addrChip(u)}
        </div>
      </div>`).join("");
  }

  /* ---------- 主搜索入口 ---------- */
  async function runSearch(q) {
    q = (q || "").trim();
    if (!q) return;
    stopTokenRefresh(); // 新搜索 → 重置实时刷新（渲染成功后再启动）
    const view = $("#searchResult");
    const content = $("#srContent");
    const title = $("#srTitle");
    const hint = $("#searchHint");
    view.style.display = "";
    content.innerHTML = '<div class="loading">搜索中…</div>';
    title.textContent = `搜索：${esc(q.length > 30 ? q.slice(0, 30) + "…" : q)}`;
    hint.textContent = "";

    // 渲染代币结果并触发评论翻译 + 排行徽章
    const renderTokenResult = async (tokenRes, q2) => {
      await ensureRankMap(); // 预加载 uid→排行 映射（Top 持有者/发言者徽章）
      const out = renderToken(tokenRes, q2);
      content.innerHTML = out.html;
      if (out.trList && out.trList.length) {
        const map = out.trList.map(({ key, text }) => {
          const el = content.querySelector(`[data-tr-key="${key}"]`);
          return [el, text];
        }).filter(([el]) => el);
        translateInto(content, map);
      }
      // 启动分模块实时刷新（价格/持有者/讨论/动态各自独立更新，无需整体重新搜索）
      const tok = (tokenRes.token && tokenRes.token.token) || {};
      __currentToken = { q: q2, addr: tok.address || q2, nid: tok.networkId };
      startTokenRefresh();
    };

    const type = detectInputType(q);
    const isAddr = type === "evm" || type === "sol";

    try {
      if (isAddr) {
        // 同时尝试：代币识别 + 钱包匹配
        const results = await Promise.allSettled([
          searchToken(q).catch(() => null),
          matchWallet(q),
        ]);
        const tokenRes = results[0].status === "fulfilled" ? results[0].value : null;
        const walletRes = results[1].status === "fulfilled" ? results[1].value : null;

        if (tokenRes && tokenRes.token) {
          title.textContent = `代币：${esc(tokenRes.token.token.symbol || "?")}（识别为代币）`;
          renderTokenResult(tokenRes, q);
          hint.textContent = "已识别为代币地址；该地址未在活跃用户集中匹配到账户。";
        } else if (walletRes && walletRes.hit) {
          content.innerHTML = renderWallet(walletRes.hit, q, walletRes.scanned);
        } else if (walletRes && walletRes.indexHit) {
          content.innerHTML = renderWallet(null, q, walletRes.scanned, walletRes.indexHit);
        } else {
          const scanned = walletRes ? walletRes.scanned : 0;
          content.innerHTML = renderWallet(null, q, scanned);
        }
      } else if (type === "handle") {
        const users = await searchHandle(q);
        title.textContent = `用户：${esc(q)}`;
        content.innerHTML = renderUsers(users);
      } else {
        // 关键词：代币短语 + 用户名模糊搜索 并行
        // (官方 fuzzy-search 支持中文/displayName, 如搜"冷静"应命中 冷静冷静再冷静)
        const [tokenRes, users] = await Promise.allSettled([
          searchToken(q).catch(() => null),
          searchHandle(q).catch(() => []),
        ]);
        const tRes = tokenRes.status === "fulfilled" ? tokenRes.value : null;
        const us = users.status === "fulfilled" ? users.value : [];
        if (tRes && tRes.token) {
          title.textContent = `代币：${esc(tRes.token.token.symbol || "?")}`;
          renderTokenResult(tRes, q);
        } else if (us.length) {
          title.textContent = `用户：${esc(q)}`;
          content.innerHTML = renderUsers(us);
        } else {
          content.innerHTML = `<div class="no-result">没有找到匹配的代币或用户，请确认输入内容。</div>`;
        }
      }
    } catch (e) {
      content.innerHTML = `<div class="error">搜索失败：${esc(e.message || e)}</div>`;
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bindSearch() {
    const input = $("#searchInput");
    const btn = $("#searchBtn");
    const close = $("#srClose");

    const doSearch = () => runSearch(input.value);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    btn.addEventListener("click", doSearch);
    close.addEventListener("click", () => {
      stopTokenRefresh();
      $("#searchResult").style.display = "none";
      $("#searchHint").textContent = "";
    });
  }

  // 暴露给 dashboard.js（在 DOMContentLoaded 后绑定）
  window.__fomoSearch = { bind: bindSearch, run: runSearch, detect: detectInputType, refresh: refreshTokenModules };
})();
