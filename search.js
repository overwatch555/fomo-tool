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
  async function searchToken(q) {
    // 1. 识别代币（按地址/短语）
    const res = await api("/proxy/filterTokensSearch", { method: "POST", body: { phrase: q } });
    const tokens = res.responseObject || [];
    if (!tokens.length) return null;
    const t = tokens[0];
    const tok = t.token || {};
    const nid = tok.networkId;
    const addr = tok.address || q;

    // 2. 并行拉取讨论、持有者、单币动态
    const [thesis, holders, tfeed] = await Promise.all([
      api("/feed/token/thesis", { params: { tokenAddress: addr, networkId: nid, threshold: 0 } }).catch(() => null),
      api("/hodlers/top?tokens=" + encodeURIComponent(JSON.stringify([{ address: addr, networkId: nid }]))).catch(() => null),
      api("/feed/token", { params: { tokenAddress: addr, networkId: nid, excludeThesis: "true", threshold: 0 } }).catch(() => null),
    ]);
    return {
      token: t,
      thesis: thesis && thesis.responseObject ? thesis.responseObject.items || [] : [],
      holders: holders && holders.responseObject ? holders.responseObject : [],
      feed: tfeed && tfeed.responseObject ? tfeed.responseObject.feed || [] : [],
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

  /* ---------- 渲染：代币 ---------- */
  function renderToken(result, q) {
    const trList = []; // 待翻译的评论 [{ key, text }]
    const t = result.token;
    const tok = t.token || {};
    const nid = tok.networkId;
    const img = (tok.info && (tok.info.imageLargeUrl || tok.info.imageSmallUrl)) || "";
    const c24 = Number(t.change24 || 0);
    const c1 = Number(t.change1 || 0);
    const b24 = Number(t.buyCount24 || 0), s24 = Number(t.sellCount24 || 0);
    const ratio = s24 > 0 ? (b24 / s24).toFixed(2) : (b24 > 0 ? "∞" : "-");

    let html = `
      <div class="token-overview">
        <img src="${esc(img)}">
        <div>
          <div class="t-name">${esc(tok.name || "未知代币")} <span class="t-sym">${esc(tok.symbol || "")}</span></div>
          <div class="t-sym" style="margin-top:3px">${esc(chainName(nid))} · ${esc(shortAddr(tok.address, 8))}</div>
        </div>
        <div class="t-grid">
          <div class="t-item"><div class="k">价格</div><div class="v">${fmtPrice(Number(t.priceUSD))}</div></div>
          <div class="t-item"><div class="k">市值</div><div class="v">${fmtUsd(Number(t.marketCap))}</div></div>
          <div class="t-item"><div class="k">24h涨跌</div><div class="v ${pctClass(c24)}">${fmtPct(c24)}</div></div>
          <div class="t-item"><div class="k">1h涨跌</div><div class="v ${pctClass(c1)}">${fmtPct(c1)}</div></div>
          <div class="t-item"><div class="k">24h成交额</div><div class="v">${fmtUsd(Number(t.volume24))}</div></div>
          <div class="t-item"><div class="k">持有人</div><div class="v">${fmtNum(t.holders, 0)}</div></div>
          <div class="t-item"><div class="k">买卖比24h</div><div class="v">${ratio}</div></div>
          <div class="t-item"><div class="k">流动性</div><div class="v">${fmtUsd(Number(t.liquidity))}</div></div>
        </div>
      </div>`;

    // 讨论区（thesis）
    html += `<div class="sec-title"><span class="bar"></span>💬 大家怎么说（${result.thesis.length}）</div>`;
    if (result.thesis.length) {
      if (window.__fomoUser) result.thesis.forEach((it) => it.userId && window.__fomoUser.indexUser({
        id: it.userId, displayName: it.displayName, userHandle: it.userHandle,
        profilePictureLink: it.profilePictureLink, networkId: it.networkId,
      }));
      result.thesis.slice(0, 15).forEach((it, ti) => {
        const c = it.comment && it.comment.comment || "";
        const at = it.authorTrade || {};
        const upnl = Number(at.unrealizedPnlUsd || 0);
        const rpnl = Number(at.realizedPnlUsd || 0);
        if (c) trList.push({ key: "t" + ti, text: c });
        html += `
        <div class="discuss-card clickable-user" data-uid="${esc(it.userId)}" title="点击查看用户详情">
          <div class="d-top">
            ${it.profilePictureLink ? `<img src="${esc(it.profilePictureLink)}">` : `<div class="avatar">F</div>`}
            <div>
              <div class="d-name">${esc(it.displayName || "匿名")}${rankBadge(it.userId)}</div>
              <div class="d-handle">@${esc(it.userHandle || "")}</div>
            </div>
            <div class="d-time">${timeAgo(it.createdAt)}</div>
          </div>
          <div class="d-text" data-tr-key="t${ti}">${esc(c)}</div>
          <div class="d-meta">
            ${at.humanTokenAmount ? `<span class="d-hold">📦 当前持仓 <b>${fmtAmount(at.humanTokenAmount)} ${esc(it.ticker || "")}</b> ${at.usdValue ? fmtUsd(at.usdValue) : ""}</span>` : ""}
            ${upnl !== 0 ? `<span class="${upnl > 0 ? "pnl-up" : "pnl-down"}">未实现盈亏 ${upnl > 0 ? "+" : ""}${fmtUsd(upnl)}</span>` : ""}
            ${rpnl !== 0 ? `<span class="${rpnl > 0 ? "pnl-up" : "pnl-down"}">已实现 ${rpnl > 0 ? "+" : ""}${fmtUsd(rpnl)}</span>` : ""}
            ${it.threshold > 0 ? `<span class="d-tag">门槛 ${fmtUsd(it.threshold)}</span>` : ""}
          </div>
        </div>`;
      });
    } else {
      html += `<div class="no-result">暂无讨论（可能还没人发观点，或该代币较冷门）</div>`;
    }

    // 谁在买/持有
    const holders = (result.holders[0] && result.holders[0].topHolders) || [];
    html += `<div class="sec-title"><span class="bar"></span>👥 Top 持有者（${holders.length}）${result.holders[0] ? ` · 总持有 ${fmtNum(result.holders[0].totalHolders, 0)} 人` : ""}</div>`;
    if (holders.length) {
      if (window.__fomoUser) holders.forEach((h) => h.user && window.__fomoUser.indexUser(h.user));
      html += holders.map((h, hi) => {
        if (hi === 0) console.log("[debug] first holder:", JSON.stringify(h));
        const u = h.user || {};
        const amt = h.humanAmount;
        return `
        <div class="wallet-user clickable-user" data-uid="${esc(u.id)}" title="点击查看用户详情">
          ${u.profilePictureLink ? `<img src="${esc(u.profilePictureLink)}">` : `<div class="avatar">F</div>`}
          <div>
            <div class="w-name">${esc(u.displayName || "未命名")}${rankBadge(u.id)}</div>
            <div class="w-handle">@${esc(u.userHandle || "")}</div>
            <div class="w-stats">
              ${amt !== undefined ? `<span>📦 持仓 <b>${fmtAmount(amt)}</b> ${h.price ? fmtPrice(h.price) : ""}</span>` : ""}
              ${h.value !== undefined ? `<span><b>${fmtUsd(h.value)}</b></span>` : ""}
              ${h.pnl !== undefined && h.pnl !== 0 ? `<span class="${pctClass(h.pnl)}">${h.pnl > 0 ? "+" : ""}${fmtUsd(h.pnl)}</span>` : ""}
            </div>
            ${addrChip(u)}
          </div>
        </div>`;
      }).join("");
    } else {
      html += `<div class="no-result">暂无持有者数据</div>`;
    }

    // 单币动态
    if (result.feed.length) {
      html += `<div class="sec-title"><span class="bar"></span>📈 最近动态（${result.feed.length}）</div>`;
      result.feed.slice(0, 8).forEach((f, fi) => {
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
    }

    return { html, trList };
  }

  /* ---------- 渲染：钱包匹配 ---------- */
  function renderWallet(hit, q, scanned, indexHit) {
    // 索引反查命中（地址曾在某用户的交易中出现）
    if (!hit && indexHit) {
      const u = indexHit.user;
      const viaLabel = indexHit.via === "swap" ? "Swap 实际执行地址" : indexHit.via === "transfer" ? "链上转账地址" : indexHit.via === "trade" ? "交易账户地址" : "绑定钱包地址";
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
        // 关键词：当作代币短语搜索
        const tokenRes = await searchToken(q);
        if (tokenRes && tokenRes.token) {
          title.textContent = `代币：${esc(tokenRes.token.token.symbol || "?")}`;
          renderTokenResult(tokenRes, q);
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
      $("#searchResult").style.display = "none";
      $("#searchHint").textContent = "";
    });
  }

  // 暴露给 dashboard.js（在 DOMContentLoaded 后绑定）
  window.__fomoSearch = { bind: bindSearch, run: runSearch, detect: detectInputType };
})();
