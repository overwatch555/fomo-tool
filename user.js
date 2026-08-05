/* user.js - 用户详情抽屉 + 地址反查索引 */
(() => {
  "use strict";

  /* ============ 全局缓存（跨模块共享） ============ */
  // uid -> 用户对象
  window.__userCache = window.__userCache || new Map();
  // 地址(lower) -> {uid, displayName, userHandle, networkId, via}
  // via: 'user'(绑定地址) | 'swap'(实际执行地址) | 'transfer'(链上转账地址)
  window.__addrIndex = window.__addrIndex || new Map();

  function indexUser(u) {
    if (!u || !u.id) return;
    // 关键: 运行时对象(排行榜/信号,通常无真实地址字段)不能覆盖预置库的真实钱包数据
    const prev = window.__userCache.get(u.id);
    if (prev && prev._seed) {
      u = { ...u, _seed: true, _evmReal: prev._evmReal, _solReal: prev._solReal, _evmFake: prev._evmFake, _solFake: prev._solFake, _note: prev.note };
    }
    window.__userCache.set(u.id, u);
    const info = { uid: u.id, displayName: u.displayName, userHandle: u.userHandle, networkId: u.networkId };
    if (u.address) setAddrInfo(u.address.toLowerCase(), { ...info, via: "user", addr: u.address, networkId: u.networkId });
    if (u.evmAddress) setAddrInfo(u.evmAddress.toLowerCase(), { ...info, via: "user", addr: u.evmAddress, networkId: u.networkId });
  }

  // 同地址多条来源时按优先级保留：mylib(用户收录) > real(自研库真实) > fake(展示假) > user(API绑定) > trade > swap > transfer
  function setAddrInfo(key, info) {
    const cur = window.__addrIndex.get(key);
    const rank = { mylib: 7, real: 5, fake: 4, user: 3, trade: 2, swap: 1, transfer: 0 };
    if (!cur || (rank[info.via] || 0) >= (rank[cur.via] || 0)) {
      window.__addrIndex.set(key, info);
    }
  }

  /* ============ 本地收录库 myLib ============
   * 用户把查到的地址收录进扩展本地库(chrome.storage.local, 持久化):
   *  - 收录时自动跑深度反查判定(是否 FOMO 钱包/展示地址/关联地址)
   *  - 可自定义标签(如"老王钱包")/备注
   *  - 融合显示:搜索/详情/排行榜/信号/GMGN页面都显示自定义标签
   */
  const myLibKey = "fomoMyLib";
  let myLib = [];   // [{addr, label, note, addedAt}]
  async function loadMyLib() {
    try { const s = await chrome.storage.local.get(myLibKey); myLib = Array.isArray(s[myLibKey]) ? s[myLibKey] : []; }
    catch (_e) { myLib = []; }
    syncMyLibIndex();
  }
  function syncMyLibIndex() {
    for (const it of myLib) {
      setAddrInfo(String(it.addr).toLowerCase(), {
        uid: "mylib:" + it.addr, via: "mylib", addr: it.addr,
        label: it.label || "已收录", note: it.note || "", addedAt: it.addedAt,
      });
    }
  }
  async function saveMyLib() { try { await chrome.storage.local.set({ [myLibKey]: myLib }); } catch (_e) {} }
  async function addMyLib(addr, label, note) {
    if (!addr) return false;
    myLib = myLib.filter((x) => x.addr.toLowerCase() !== String(addr).toLowerCase());
    myLib.push({ addr, label: label || "", note: note || "", addedAt: Date.now() });
    await saveMyLib();
    syncMyLibIndex();
    return true;
  }
  async function removeMyLib(addr) {
    myLib = myLib.filter((x) => x.addr.toLowerCase() !== String(addr).toLowerCase());
    await saveMyLib();
    window.__addrIndex.delete(String(addr).toLowerCase());
    return true;
  }
  function getMyLib() { return myLib.slice(); }
  loadMyLib();

  /* ============ 预置地址库种子（自研反查成果,151 人 / 495 地址） ============
   * address_db.js 由 build_db.js 生成（编译进扩展,同步可用,不走 fetch）：
   *  - 150 人监控名单(真实 EVM/SOL + 平台展示假地址 + userId)
   *  - hexiecs(冷静冷静再冷静) 自研反查档案
   * 真实地址标 via=real,展示假地址标 via=fake,运行时动态索引优先级低于 real。
   */
  let dbSeeded = false;
  function seedDb() {
    if (dbSeeded) return;
    dbSeeded = true;
    const db = window.__FOMO_DB;
    if (!db || !Array.isArray(db.users)) return;
    window.__fomoDb = db;
    for (const u of db.users) {
      const obj = {
        id: u.id, displayName: u.displayName || u.handle || "", userHandle: u.handle,
        followers: u.followers, numTrades: u.numTrades, totalVolume: u.totalVolume,
        pnl24h: u.pnl24h, bestToken: u.bestToken, bestPnl: u.bestPnl,
        conf: u.conf, note: u.note, _seed: true,
        _evmReal: u.evmReal, _solReal: u.solReal, _evmFake: u.evmFake, _solFake: u.solFake,
      };
      window.__userCache.set(u.id, obj);
    }
    for (const [addr, m] of Object.entries(db.addrMap)) {
      const isReal = m.kind === "real_evm" || m.kind === "real_sol";
      const u = window.__userCache.get(m.uid) || {};
      setAddrInfo(addr, {
        uid: m.uid, via: isReal ? "real" : "fake", addr,
        displayName: u.displayName, userHandle: u.userHandle,
        networkId: m.kind === "real_sol" || m.kind === "fake_sol" ? 1399811149 : (m.kind === "real_evm" || m.kind === "fake_evm" ? 8453 : null),
      });
    }
  }
  // 页面加载后尽早预置(同步,幂等)
  seedDb();

  /* ============ 反查结果自动收录(地址库增量) ============
   * 一键反查出的真实地址, 自动持久化到 chrome.storage.local(fomoLookupHits, uid→记录),
   * 并立即并入 __userCache / __addrIndex(与预置库同等 real 优先级):
   *   - 钱包地址搜索、用户详情、导出、GMGN 打标 马上生效
   *   - 无需手工改 address_db.js(由 build_db.js 生成,勿手改)
   */
  const lookupHitsKey = "fomoLookupHits";
  let lookupHits = new Map(); // uid -> { displayName, handle, evm, evmChainId, sol, ts }

  function applyLookupHit(uid, h) {
    if (!uid || !h) return;
    lookupHits.set(uid, h);
    const prev = window.__userCache.get(uid) || {};
    const merged = {
      ...prev,
      id: prev.id || uid,
      displayName: h.displayName || prev.displayName || "",
      userHandle: h.handle || prev.userHandle || "",
      _seed: true, // 标记为库数据, 防止运行时对象覆盖真实钱包
      _evmReal: h.evm || prev._evmReal || null,
      _solReal: h.sol || prev._solReal || null,
    };
    window.__userCache.set(uid, merged);
    const info = { uid, displayName: h.displayName || prev.displayName || "", userHandle: h.handle || prev.userHandle || "" };
    if (h.evm) setAddrInfo(String(h.evm).toLowerCase(), { ...info, via: "real", addr: h.evm, networkId: h.evmChainId || 8453 });
    if (h.sol) setAddrInfo(String(h.sol).toLowerCase(), { ...info, via: "real", addr: h.sol, networkId: 1399811149 });
  }

  async function saveLookupHit(uid, h) {
    applyLookupHit(uid, h);
    try {
      const s = await chrome.storage.local.get(lookupHitsKey);
      const map = s[lookupHitsKey] || {};
      map[uid] = { ...(map[uid] || {}), ...h, ts: Date.now() };
      await chrome.storage.local.set({ [lookupHitsKey]: map });
      return true;
    } catch (_e) { return false; }
  }

  async function seedLookupHits() {
    try {
      const s = await chrome.storage.local.get(lookupHitsKey);
      const map = s[lookupHitsKey] || {};
      for (const [uid, h] of Object.entries(map)) applyLookupHit(uid, h);
    } catch (_e) {}
  }
  seedLookupHits();

  function indexTradeAddrs(tradeId, trade, swaps, transfers, uidFallback) {
    const uid = trade.userId || uidFallback;
    if (!uid) return;
    const u = window.__userCache.get(uid);
    const info = { uid, displayName: u ? u.displayName : "", userHandle: u ? u.userHandle : "", networkId: trade.networkId };
    if (trade.userAddress) {
      setAddrInfo(trade.userAddress.toLowerCase(), { ...info, via: "trade", addr: trade.userAddress, networkId: trade.networkId });
    }
    (swaps || []).forEach((s) => {
      if (s.address) {
        setAddrInfo(s.address.toLowerCase(), { ...info, via: "swap", addr: s.address, networkId: s.networkId || s.inNetworkId });
      }
    });
    (transfers || []).forEach((t) => {
      if (t.fromAddress) setAddrInfo(t.fromAddress.toLowerCase(), { ...info, via: "transfer", addr: t.fromAddress, networkId: t.networkId });
      if (t.toAddress) setAddrInfo(t.toAddress.toLowerCase(), { ...info, via: "transfer", addr: t.toAddress, networkId: t.networkId });
    });
  }

  /* ============ API 封装（与 dashboard.js 一致） ============ */
  async function api(path, options) {
    const r = await chrome.runtime.sendMessage({ action: "call", path, options });
    if (!r || !r.ok) throw new Error(r ? r.error : "background 无响应");
    if (!r.r.ok) {
      if (r.r.status === 401) throw new Error("JWT 已过期");
      if (r.r.status === 403) throw new Error("被 Cloudflare 拦截");
      throw new Error("HTTP " + r.r.status);
    }
    return r.r.data;
  }

  /* ============ 链上浏览器链接 ============ */
  const EXPLORERS = {
    1: "https://etherscan.io/address/",
    56: "https://bscscan.com/address/",
    8453: "https://basescan.org/address/",
    4663: "https://robinhoodchain.blockscout.com/address/",
    1399811148: "https://robinhoodchain.blockscout.com/address/",
    1399811149: "https://solscan.io/account/",
  };
  function explorerLink(nid, addr) {
    const base = EXPLORERS[nid];
    return base ? base + addr : "";
  }

  /* ============ 链上指纹检查（地址真伪判定） ============
   * FOMO 真实 EVM 钱包 = EIP-7702 委托到平台逻辑合约；
   * API 绑定地址是展示假地址（链上零活动）。
   * 走后台 checkFingerprint（公共 RPC + 缓存）。
   */
  async function fpCheck(chainId, addr) {
    if (!addr || !addr.startsWith("0x") || !chainId) return null;
    try {
      const r = await chrome.runtime.sendMessage({ action: "fpCheck", chainId, addr });
      return r && r.ok ? r.fp : null;
    } catch (_e) { return null; }
  }

  function fpBadge(fp, isBound) {
    if (!fp) return "";
    if (fp.kind === "fomo") return `<span class="fp-badge fp-real" title="EIP-7702 委托到 FOMO 账户逻辑合约">✅ 真实钱包</span>`;
    if (fp.kind === "other7702") return `<span class="fp-badge fp-7702" title="EIP-7702 委托到其他逻辑">7702→${fp.delegate.slice(0, 10)}…</span>`;
    if (fp.kind === "eoa" && isBound) return `<span class="fp-badge fp-fake" title="链上零活动，API 展示地址">⚠️ 展示地址</span>`;
    if (fp.kind === "eoa") return `<span class="fp-badge fp-eoa">EOA</span>`;
    if (fp.kind === "contract") return `<span class="fp-badge fp-contract">合约</span>`;
    return "";
  }

  // 异步为容器内所有地址行补徽章
  // 优先用预置地址库判定(real/fake,零网络请求),库里没有才走链上指纹检查
  async function annotateAddrs(container) {
    if (!container) return;
    const rows = Array.from(container.querySelectorAll(".ud-addr[data-addr]"));
    for (const row of rows) {
      const addr = row.dataset.addr;
      const nid = Number(row.dataset.chain);
      const badgeEl = row.querySelector(".ud-addr-badges");
      if (!badgeEl) continue;
      // ① 预置库/本地收录库标记
      if (window.__addrIndex) {
        const entry = window.__addrIndex.get(addr.toLowerCase());
        if (entry && entry.via === "mylib") {
          badgeEl.innerHTML += `<span class="fp-badge fp-real" title="${esc(entry.note || "本地收录")}">📌 ${esc(entry.label || "已收录")}</span>`;
          continue;
        }
        if (entry && (entry.via === "real" || entry.via === "fake")) {
          badgeEl.innerHTML += entry.via === "real"
            ? `<span class="fp-badge fp-real" title="自研反查地址库">✅ 真实钱包</span>`
            : `<span class="fp-badge fp-fake" title="平台展示地址,非真实钱包">⚠️ 展示地址</span>`;
          continue;
        }
      }
      // ② 链上指纹检查(仅 EVM)
      if (!addr.startsWith("0x") || !nid) continue;
      const fp = await fpCheck(nid, addr);
      if (!fp) continue;
      const isBound = row.dataset.bound === "1";
      badgeEl.innerHTML += fpBadge(fp, isBound);
    }
  }

  /* 地址库状态（标题旁小字,一眼确认库是否加载成功） */
  function dbState() {
    const db = window.__FOMO_DB;
    if (db && Array.isArray(db.users)) {
      const extra = lookupHits.size ? ` + ${lookupHits.size} 反查` : "";
      return ` <span style="font-size:10px;color:var(--muted);font-weight:400">库 ${db.users.length} 人${extra}</span>`;
    }
    return ` <span style="font-size:10px;color:#f87171;font-weight:400">地址库未加载</span>`;
  }

  /* ============ 抽屉 DOM ============ */
  const mask = () => document.getElementById("userDrawerMask");
  const body = () => document.getElementById("drawerBody");

  function open() {
    const m = mask();
    if (m) m.classList.add("show");
  }
  function close() {
    const m = mask();
    if (m) m.classList.remove("show");
  }
  document.addEventListener("click", async (e) => {
    if (e.target.closest("#drawerClose")) close();
    if (e.target === mask()) close();
    // 收录到本地库: 地址行 📌 按钮
    const saveBtn = e.target.closest("[data-save]");
    if (saveBtn) {
      e.preventDefault();
      const addr = saveBtn.getAttribute("data-save");
      const label = prompt("给这个地址起个标签(如: 老王钱包), 留空用默认:", "");
      if (label === null) return;
      await addMyLib(addr, label, "");
      saveBtn.textContent = "✅";
      saveBtn.title = "已收录";
    }
  });

  /* ============ 渲染 ============ */
  function heroHTML(u) {
    const cover = u.coverPhotoLink
      ? `<div class="ud-cover"><img src="${esc(u.coverPhotoLink)}"></div>`
      : `<div class="ud-cover"></div>`;
    const avatar = u.profilePictureLink
      ? `<img class="ud-avatar" src="${esc(u.profilePictureLink)}">`
      : `<div class="ud-avatar" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-weight:700">F</div>`;
    const tags = [];
    if (u.activated) tags.push("已激活");
    if (u.private) tags.push("🔒 私密");
    if (u.isRestricted) tags.push("⚠ 受限");
    const tagHTML = tags.length ? `<div class="ud-tags">${tags.map((t) => `<span class="ud-tag">${t}</span>`).join("")}</div>` : "";
    return `
      <div class="ud-hero">
        ${cover}
        <div class="ud-main">
          ${avatar}
          <div class="ud-name">${esc(u.displayName || "未命名")}${rankBadge(u.id)}</div>
          <div class="ud-handle">@${esc(u.userHandle || "")}</div>
          ${u.description ? `<div class="ud-desc">${esc(u.description)}</div>` : ""}
          ${tagHTML}
        </div>
      </div>`;
  }

  function statsHTML(u) {
    const cells = [
      ["粉丝", fmtNum(u.followers, 0)],
      ["关注", fmtNum(u.following, 0)],
      ["交易数", fmtNum(u.numTrades, 0)],
      ["Swap次数", fmtNum(u.swapCount, 0)],
      ["总交易额", fmtUsd(u.totalVolume)],
      ["24h盈亏", u.pnl24h != null ? (u.pnl24h > 0 ? "+" : "") + fmtUsd(u.pnl24h) : "-"],
    ];
    if (u.totalHoldings != null) cells.push(["持仓币种", fmtNum(u.totalHoldings, 0)]);
    if (u.createdAt) cells.push(["加入", (u.createdAt || "").slice(0, 10)]);
    return `
      <div class="ud-stats">
        ${cells.map(([l, v]) => `
          <div class="ud-stat"><div class="v ${typeof v === "number" && v < 0 ? "down" : ""}">${v}</div><div class="l">${l}</div></div>
        `).join("")}
      </div>`;
  }

  /* replaceWith 只接受节点；把 HTML 字符串转成节点再替换 */
  function replaceHTML(el, html) {
    if (!el) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    el.replaceWith(tmp.firstElementChild);
  }

  function addrRowHTML(label, chainLabel, addr, nid, cls, bound) {
    const link = explorerLink(nid, addr);
    return `
      <div class="ud-addr" data-addr="${esc(addr)}" data-chain="${nid || ""}" data-bound="${bound ? "1" : "0"}">
        <span class="ud-addr-chain ${cls || ""}">${chainLabel}</span>
        <span class="ud-addr-label">${label}</span>
        <span class="ud-addr-full" title="${esc(addr)}">${esc(addr)}</span>
        <span class="ud-addr-badges"></span>
        <button class="copy-btn" data-copy="${esc(addr)}" title="复制">📋</button>
        <button class="copy-btn" data-save="${esc(addr)}" title="收录到本地库">📌</button>
        ${link ? `<a class="ud-addr-link" href="${link}" target="_blank" rel="noopener">链上 ↗</a>` : ""}
      </div>`;
  }

  function addrsHTML(u, onchain) {
    let html = "";
    // ① 自研反查库的真实钱包优先展示（有 _evmReal/_solReal 说明我们扒过）
    if (u._solReal) html += addrRowHTML("真实钱包 · Solana", "Solana", u._solReal, 1399811149, "real");
    if (u._evmReal) html += addrRowHTML("真实钱包 · EVM", "EVM", u._evmReal, 8453, "real");
    // ② API 绑定地址（平台展示地址,已知/待验证为假）
    if (u.address) html += addrRowHTML("平台绑定（展示）", "Solana", u.address, u.networkId || 1399811149, "fake");
    if (u.evmAddress) html += addrRowHTML("平台绑定（展示）", "EVM", u.evmAddress, 1, "evm");
    // ③ 运行时链上活动地址
    (onchain || []).forEach(({ label, chainLabel, addr, nid, cls }) => {
      html += addrRowHTML(label, chainLabel, addr, nid, cls, false);
    });
    if (!html) html = `<div class="ud-empty">该用户未公开钱包地址</div>`;
    return html;
  }

  /* 持仓列表（含每笔盈亏 + 汇总盈亏条） */
  function holdingsHTML(holdings) {
    if (!holdings || !holdings.length) return `<div class="ud-empty">暂无持仓数据</div>`;
    let sumVal = 0, sumPnl = 0, hasVal = false, hasPnl = false;
    const rows = holdings.map((h) => {
      const val = Number(h.value);
      const pnl = Number(h.pnl);
      if (isFinite(val) && val > 0) { sumVal += val; hasVal = true; }
      if (isFinite(pnl) && pnl !== 0) { sumPnl += pnl; hasPnl = true; }
      // 盈亏百分比：优先接口字段，否则按 成本≈市值-盈亏 推算
      let pnlPct = h.pnlPct;
      if (pnlPct == null && isFinite(val) && isFinite(pnl) && val - pnl > 0) {
        pnlPct = (pnl / (val - pnl)) * 100;
      }
      const pnlTxt = isFinite(pnl) && pnl !== 0
        ? `<div class="ud-h-pnl ${pctClass(pnl)}">${pnl > 0 ? "▲" : "▼"} ${pnl > 0 ? "+" : ""}${fmtUsd(pnl)}${pnlPct != null ? ` (${pnl > 0 ? "+" : ""}${fmtPct(pnlPct / 100)})` : ""}</div>`
        : "";
      return { h, pnlTxt };
    });
    const sumRow = (hasVal || hasPnl) ? `
      <div class="ud-hold-sum">
        <span>总市值 ${hasVal ? fmtUsd(sumVal) : "-"}</span>
        ${hasPnl ? `<span class="${pctClass(sumPnl)}">总盈亏 ${sumPnl > 0 ? "+" : ""}${fmtUsd(sumPnl)}</span>` : ""}
      </div>` : "";
    return sumRow + rows.map(({ h, pnlTxt }) => `
      <div class="ud-holding">
        <img src="${esc(h.imageUrl || "")}">
        <div class="ud-h-main">
          <div class="ud-h-symbol">${esc(h.symbol || (h.tokenAddress ? shortAddr(h.tokenAddress, 5) : "?"))}<span class="ud-h-chain">${esc(chainName(h.networkId))}</span></div>
          <div class="ud-h-sub">${h.humanAmount != null ? fmtAmount(h.humanAmount) + " 枚" : "-"}${h.price ? ` · @${fmtPrice(h.price)}` : ""}</div>
        </div>
        <div class="ud-h-right">
          <div class="ud-h-val">${h.value != null ? fmtUsd(h.value) : "-"}</div>
          ${pnlTxt}
        </div>
      </div>`).join("");
  }

  function tradeRowHTML(t) {
    const tokenMeta = t.tokenMetadata || {};
    const img = tokenMeta.imageThumbUrl || tokenMeta.imageLargeUrl || tokenMeta.imageSmallUrl || "";
    const isOpen = t.closedAt == null && t.status !== "closed";
    const statusCls = isOpen ? "open" : (t.realizedPnlUsd > 0 ? "win" : t.realizedPnlUsd < 0 ? "loss" : "closed");
    const statusTxt = isOpen ? "持仓中" : (t.realizedPnlUsd > 0 ? "盈利" : t.realizedPnlUsd < 0 ? "亏损" : "已平仓");
    return `
      <div class="ud-trade" data-trade-id="${esc(t.id)}">
        <div class="ud-trade-top">
          <img src="${esc(img)}">
          <span class="ud-trade-sym">${esc(tokenMeta.symbol || shortAddr(t.tokenAddress, 5))}</span>
          <span class="ud-trade-chain">${esc(chainName(t.networkId))}</span>
          <span class="ud-trade-status ${statusCls}">${statusTxt}</span>
          <div class="ud-trade-meta">
            <div class="ud-trade-pnl ${pctClass(t.realizedPnlUsd || t.unrealizedPnlUsd || 0)}">
              ${t.realizedPnlUsd != null ? (t.realizedPnlUsd > 0 ? "+" : "") + fmtUsd(t.realizedPnlUsd) : (t.unrealizedPnlUsd != null ? "浮盈 " + fmtUsd(t.unrealizedPnlUsd) : "-")}
            </div>
            <div>${t.humanTokenAmount != null ? fmtAmount(t.humanTokenAmount) + " 枚" : "-"} · ${timeAgo(t.closedAt || t.createdAt)}</div>
          </div>
        </div>
        <div class="ud-trade-detail"></div>
      </div>`;
  }

  /* ============ 数据加载 ============ */
  async function loadTrades(uid, render) {
    // FOMO 的 /trades 接口对参数敏感（orderBy=closedAt 有时需 tokenAddress 配合，否则 400）。
    // 逐个尝试已知可用用法，并兼容不同返回结构。
    const attempts = [
      // ① 分页列表：不带 orderBy → items 嵌套结构（最稳定）
      "/trades?userId=" + encodeURIComponent(uid) + "&limit=25",
      // ② 带 orderBy=closedAt → activeTrades/closedTrades 结构
      "/trades?userId=" + encodeURIComponent(uid) + "&orderBy=closedAt&limit=25",
    ];
    let lastErr = null;
    for (const path of attempts) {
      try {
        const data = await api(path);
        const ro = data.responseObject || data || {};
        let list = null;
        if (Array.isArray(ro)) {
          list = ro;
        } else if (ro.items && Array.isArray(ro.items)) {
          // 嵌套结构：每项 {trade, swaps, transfers, comment, type}
          list = ro.items.map((it) => (it && it.trade ? it.trade : it));
        } else if (ro.activeTrades || ro.closedTrades) {
          // 该结构每项为 {trade: {...}} 包装，需解包
          list = [...(ro.activeTrades || []), ...(ro.closedTrades || [])].map((it) => (it && it.trade ? it.trade : it));
        }
        if (list === null) throw new Error("返回结构未知");
        render(list);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    render(null, lastErr ? lastErr.message : "未知错误");
  }

  async function loadTradeDetail(tradeId) {
    const data = await api("/trades/" + tradeId);
    return data.responseObject || data || {};
  }

  async function loadBalances(uid) {
    try {
      const data = await api("/v2/users/" + encodeURIComponent(uid) + "/balances");
      const ro = data.responseObject || data || {};
      return ro.balances || [];
    } catch (e) {
      return [];
    }
  }

  /* 归一化持仓条目：兼容 topHoldings 直通字段 与 balances 的嵌套 balance + tokenFilterResult 结构 */
  function normalizeHolding(x) {
    const bal = (x && x.balance && typeof x.balance === "object") ? x.balance : x || {};
    const tf = (x && x.tokenFilterResult && typeof x.tokenFilterResult === "object") ? x.tokenFilterResult : {};
    const tinfo = (tf.token && tf.token.info && typeof tf.token.info === "object") ? tf.token.info : {};
    // networkId：优先 balance.networkId；否则从 tokenId 末尾 ":数字" 解析
    let nid = bal.networkId;
    if (nid == null && bal.tokenId) {
      const m = String(bal.tokenId).split(":").pop();
      if (/^\d+$/.test(m)) nid = Number(m);
    }
    if (nid == null && x && x.networkId != null) nid = x.networkId;
    const price = bal.price ?? tf.priceUSD ?? tf.price ?? (x && x.price);
    const shifted = bal.shiftedBalance ?? bal.humanAmount;
    return {
      imageUrl: bal.imageUrl || tf.imageUrl || tinfo.imageSmallUrl || tinfo.imageThumbUrl || tinfo.imageLargeUrl || tinfo.imageBannerUrl || (x && x.imageUrl),
      symbol: bal.symbol || (tf.token && tf.token.symbol) || (x && x.symbol),
      name: bal.name || (tf.token && tf.token.name) || (x && x.name),
      tokenAddress: bal.tokenAddress || (x && x.tokenAddress),
      networkId: nid,
      humanAmount: shifted ?? (x && (x.humanAmount ?? x.amount)),
      value: bal.value ?? bal.valueUsd ?? bal.usdValue ?? (price != null && shifted != null ? price * shifted : undefined) ?? (x && (x.usdValue ?? x.value)),
      pnl: bal.pnl ?? bal.unrealizedPnl ?? bal.unrealizedPnlUsd ?? bal.profitLossUsd ?? bal.profitLoss ?? (x && (x.pnl ?? x.unrealizedPnlUsd ?? x.profitLossUsd)),
      pnlPct: bal.pnlPct ?? bal.pnlPercent ?? bal.unrealizedPnlPct ?? (x && (x.pnlPct ?? x.pnlPercent)),
      price,
    };
  }

  async function loadUserDetail(uid, handle) {
    if (!handle) return null;
    try {
      const data = await api("/v2/users/userHandle/" + encodeURIComponent(handle));
      const ro = data.responseObject || data || {};
      const u = ro.user || ro;
      if (u && u.id) { indexUser(u); return u; }
      return null;
    } catch (e) {
      return null;
    }
  }

  /* ============ 主入口 ============ */
  function openUserDrawer(uid, partial) {
    if (!uid) return;
    open();
    const b = body();
    if (!b) return;
    b.innerHTML = `<div class="loading">加载中…</div>`;

    let u = window.__userCache.get(uid) || partial || {};
    if (u && u.id && u !== partial) indexUser(u);

    // 预加载排行映射（头像排行徽章）
    ensureRankMap().then(() => {
      // 若抽屉还开着，刷新排行徽章
      const m = mask();
      if (m && m.classList.contains("show")) {
        const hero = b.querySelector(".ud-hero");
        if (hero) hero.outerHTML = heroHTML(window.__userCache.get(uid) || partial || {});
      }
    }).catch(() => {});

    // 头部先用已有信息渲染
    b.innerHTML = `
      ${heroHTML(u)}
      <div class="ud-sec"><div class="ud-sec-title">钱包地址<span class="ud-dbstate">${dbState()}</span></div><div class="ud-addrs">${addrsHTML(u, [])}</div></div>
      <div class="ud-sec">
        <div class="ud-sec-title">🔍 真实链上地址反查 (EIP-7702 & 时间戳对撞)</div>
        <div class="lookup-box">
          <div class="lookup-tip">💡 API 提供的地址通常为平台生成的占位地址（零链上活动）。点击下方按钮通过链上 Transfer 事件对撞 + 7702 指纹反查真实钱包。</div>
          <button class="lookup-btn" id="runLookupBtn">⚡ 一键反查真实链上地址</button>
          <div id="lookupProgress" class="lookup-progress" style="display:none">
            <div class="lookup-progress-bar"><div class="fill" id="lookupBarFill" style="width:0%"></div></div>
            <div class="lookup-status" id="lookupStatusText">正在初始化 RPC 节点...</div>
          </div>
          <div id="lookupResult" class="lookup-result" style="display:none"></div>
        </div>
      </div>
      <div class="ud-sec"><div class="ud-sec-title">数据总览</div>${statsHTML(u)}</div>
      <div class="ud-sec"><div class="ud-sec-title">持仓代币</div><div id="udHoldings" class="ud-holdings"><div class="loading" style="padding:10px">加载中…</div></div></div>
      <div class="ud-sec"><div class="ud-sec-title">交易记录</div><div id="udTrades"><div class="loading" style="padding:10px">加载中…</div></div></div>
      <div class="ud-sec"><div class="ud-sec-title">链上活动地址</div><div id="udOnchain"><div class="ud-empty">展开下方交易记录后，实际链上执行地址会出现在这里</div></div></div>
    `;
    annotateAddrs(b.querySelector(".ud-addrs"));

    // 补充详情（若只有信号条目，尝试拉完整用户）
    if (!u.id) u = {};
    if (!partial || !partial.id) {
      const cached = window.__userCache.get(uid);
      if (cached) {
        u = cached;
        b.querySelector(".ud-hero").outerHTML = heroHTML(u);
        b.querySelector(".ud-addrs").innerHTML = addrsHTML(u, []);
        annotateAddrs(b.querySelector(".ud-addrs"));
        replaceHTML(b.querySelector(".ud-stats"), statsHTML(u));
      }
    }
    // 用 handle 补充完整资料（信号条目等只有 handle 的来源）
    const handle = u.userHandle || partial?.userHandle;
    if (!u.description && handle) {
      loadUserDetail(uid, handle).then((full) => {
        if (!full) return;
        // 合并预置库字段(API 资料里没有真实钱包,别覆盖自研反查成果)
        const seedU = window.__userCache.get(uid);
        if (seedU && seedU._seed) {
          full = { ...full, _evmReal: seedU._evmReal, _solReal: seedU._solReal, _evmFake: seedU._evmFake, _solFake: seedU._solFake, _seed: true };
        }
        u = full;
        window.__userCache.set(uid, full);
        const heroEl = b.querySelector(".ud-hero");
        if (heroEl) heroEl.outerHTML = heroHTML(full);
        const addrEl = b.querySelector(".ud-addrs");
        if (addrEl) { addrEl.innerHTML = addrsHTML(full, []); annotateAddrs(addrEl); }
        const statsEl = b.querySelector(".ud-stats");
        if (statsEl) replaceHTML(statsEl, statsHTML(full));
        const hEl = b.querySelector("#udHoldings");
        if (hEl && full.topHoldings) hEl.innerHTML = holdingsHTML(full.topHoldings.map(normalizeHolding));
      });
    }

    // 一键反查按钮(朋友版 lookup 引擎)
    const runBtn = b.querySelector("#runLookupBtn");
    if (runBtn && window.__lookup) {
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        runBtn.style.opacity = "0.6";
        const progressEl = b.querySelector("#lookupProgress");
        const barFill = b.querySelector("#lookupBarFill");
        const statusText = b.querySelector("#lookupStatusText");
        const resEl = b.querySelector("#lookupResult");
        progressEl.style.display = "block";
        resEl.style.display = "none";
        barFill.style.width = "5%";
        statusText.textContent = "准备中...";
        try {
          const res = await window.__lookup.startLookup(uid, (p) => {
            if (p.progressPct) barFill.style.width = p.progressPct + "%";
            if (p.detail) statusText.textContent = p.detail;
          });
          progressEl.style.display = "none";
          resEl.style.display = "block";
          // 反查命中 → 自动收录到地址库(本地持久化 + 内存索引即时生效)
          let savedHits = 0;
          if (res.evm && res.evm.address) {
            const ok = await saveLookupHit(uid, {
              displayName: u.displayName || u.userHandle || "",
              handle: u.userHandle || "",
              evm: res.evm.address,
              evmChainId: res.mainEvmChain,
            });
            if (ok) savedHits++;
          }
          if (res.sol && res.sol.address) {
            const ok = await saveLookupHit(uid, {
              displayName: u.displayName || u.userHandle || "",
              handle: u.userHandle || "",
              sol: res.sol.address,
            });
            if (ok) savedHits++;
          }
          let resHTML = savedHits
            ? `<div class="lookup-saved">✅ 已自动收录 ${savedHits} 个真实地址到地址库（本地持久化，地址搜索 / 用户详情 / 导出 / GMGN 打标立即生效）</div>`
            : "";
          // 立即刷新"钱包地址"区, 展示刚收录进库的真实地址
          if (savedHits) {
            const cachedU = window.__userCache.get(uid) || u;
            const addrsBox = b.querySelector(".ud-addrs");
            if (addrsBox) {
              addrsBox.innerHTML = addrsHTML(cachedU, []);
              annotateAddrs(addrsBox);
            }
            const dbTxt = b.querySelector(".ud-dbstate");
            if (dbTxt) dbTxt.innerHTML = dbState();
          }
          if (!res.hasSwaps) {
            resHTML = `<div class="lookup-empty">该用户在链上暂无 Swap 交易记录，无法反查。</div>`;
          } else {
            const evm = res.evm, sol = res.sol;
            if (evm && evm.address) {
              const confLabel = evm.confidence === "iron" ? "🎯 铁证级 (金额精准对账一致)" : evm.confidence === "strong" ? "⚡ 强证据 (多窗口高频出现)" : "🔍 弱线索 (偶发出现)";
              const confClass = evm.confidence === "iron" ? "iron" : evm.confidence === "strong" ? "strong" : "weak";
              const exLink = EXPLORERS[res.mainEvmChain] ? EXPLORERS[res.mainEvmChain] + evm.address : "";
              resHTML += `
                <div class="lookup-res-card ${confClass}">
                  <div class="lookup-res-head">
                    <span class="lookup-res-title">EVM 真实钱包 (EIP-7702 验证)</span>
                    <span class="confidence-badge ${confClass}">${confLabel}</span>
                  </div>
                  <div class="lookup-res-addr">
                    <span class="addr-full">${esc(evm.address)}</span>
                    <button class="copy-btn" data-copy="${esc(evm.address)}" title="复制">📋</button>
                    ${exLink ? `<a href="${exLink}" target="_blank" rel="noopener">链上↗</a>` : ""}
                  </div>
                  <div class="lookup-res-meta">
                    <span>窗口命中率：<b>${evm.hitWindows}/${evm.totalWindows}</b> (${evm.hitRate})</span>
                    ${evm.amountMatches > 0 ? `<span>金额对账：<b class="up">✓ ${evm.amountMatches} 笔精确一致</b></span>` : ""}
                  </div>
                </div>`;
            } else if (evm) {
              const errMsg = evm.lastError ? `<div class="lookup-empty-sub">RPC 故障：${esc(String(evm.lastError).slice(0, 120))}${evm.aborted ? "（已熔断中止）" : ""}</div>` : "";
              resHTML += `<div class="lookup-empty">EVM 链未搜寻到符合 7702 指纹的真实地址（已扫描 ${evm.stats.scanned} 个窗口）。</div>${errMsg}`;
            }
            if (res.chainResults && res.chainResults.length > 1) {
              resHTML += `<div class="lookup-empty-sub">多链结果：${res.chainResults.map((c) => `${c.chainId}(${c.scanned}窗${c.address ? "✅" : c.aborted ? "❌" : "—"})`).join(" ")}</div>`;
            }
            if (sol && sol.address) {
              const solEx = EXPLORERS[1399811149] ? EXPLORERS[1399811149] + sol.address : "";
              resHTML += `
                <div class="lookup-res-card strong mt8">
                  <div class="lookup-res-head">
                    <span class="lookup-res-title">Solana 真实钱包 (跨链印证)</span>
                    <span class="confidence-badge strong">⚡ 强证据 (${esc(sol.source)})</span>
                  </div>
                  <div class="lookup-res-addr">
                    <span class="addr-full">${esc(sol.address)}</span>
                    <button class="copy-btn" data-copy="${esc(sol.address)}" title="复制">📋</button>
                    ${solEx ? `<a href="${solEx}" target="_blank" rel="noopener">链上↗</a>` : ""}
                  </div>
                  ${sol.detail ? `<div class="lookup-res-meta"><span>${esc(sol.detail)}</span></div>` : ""}
                </div>`;
            }
          }
          resEl.innerHTML = resHTML || `<div class="lookup-empty">无反查结果</div>`;
        } catch (e) {
          progressEl.style.display = "none";
          resEl.style.display = "block";
          resEl.innerHTML = `<div class="lookup-empty">反查失败：${esc(String(e).slice(0, 120))}</div>`;
        } finally {
          runBtn.disabled = false;
          runBtn.style.opacity = "1";
        }
      });
    }

    // 持仓：topHoldings 立即渲染(快)；balances 接口含盈亏数据，返回后总是覆盖(更全)
    if (u.topHoldings && u.topHoldings.length) {
      b.querySelector("#udHoldings").innerHTML = holdingsHTML(u.topHoldings.map(normalizeHolding));
    }
    loadBalances(uid).then((bl) => {
      const el = b.querySelector("#udHoldings");
      if (!el) return;
      if (bl && bl.length) el.innerHTML = holdingsHTML(bl.map(normalizeHolding));
      else if (!u.topHoldings || !u.topHoldings.length) el.innerHTML = `<div class="ud-empty">暂无持仓数据</div>`;
    });

    // 交易记录
    loadTrades(uid, (list, err) => {
      const el = b.querySelector("#udTrades");
      if (!el) return;
      if (err) { el.innerHTML = `<div class="ud-empty">加载失败：${esc(err)}</div>`; return; }
      if (!list.length) { el.innerHTML = `<div class="ud-empty">暂无交易记录</div>`; return; }
      el.innerHTML = list.map((t) => tradeRowHTML(t)).join("");

      // 展开单笔交易详情（silent 时不展开 UI，只建地址索引）
      async function expandTrade(row, silent) {
        const detailEl = row.querySelector(".ud-trade-detail");
        if (!silent) {
          const wasOpen = row.classList.contains("open");
          el.querySelectorAll(".ud-trade.open").forEach((r) => r.classList.remove("open"));
          if (wasOpen) return;
          row.classList.add("open");
          detailEl.innerHTML = `<div class="loading" style="padding:8px">拉取链上明细…</div>`;
        }
        try {
          const d = await loadTradeDetail(row.dataset.tradeId);
          const tr = d.trade || {};
          indexTradeAddrs(tr.id, tr, d.swaps, d.transfers, uid);
          if (silent) return;
          // 渲染详情
          const rows = [];
          if (tr.avgEntryPrice != null) rows.push(["开仓均价", fmtPrice(tr.avgEntryPrice)]);
          if (tr.avgExitPrice != null) rows.push(["平仓均价", fmtPrice(tr.avgExitPrice)]);
          if (tr.humanTokenAmount != null) rows.push(["数量", fmtNum(tr.humanTokenAmount) + " 枚"]);
          if (tr.totalCostBasis != null) rows.push(["成本", fmtUsd(tr.totalCostBasis)]);
          if (tr.realizedPnlUsd != null) rows.push(["已实现盈亏", (tr.realizedPnlUsd > 0 ? "+" : "") + fmtUsd(tr.realizedPnlUsd)]);
          if (tr.unrealizedPnlUsd != null) rows.push(["未实现盈亏", fmtUsd(tr.unrealizedPnlUsd)]);
          if (tr.createdAt) rows.push(["开仓", new Date(tr.createdAt).toLocaleString()]);
          if (tr.closedAt) rows.push(["平仓", new Date(tr.closedAt).toLocaleString()]);
          let html = rows.map(([l, v]) => `<div class="ud-td-row"><span>${l}</span><b>${v}</b></div>`).join("");

          const swaps = d.swaps || [];
          if (swaps.length) {
            html += `<div class="ud-td-sec">链上 Swaps（${swaps.length}）</div>`;
            swaps.slice(0, 6).forEach((s) => {
              html += `<div class="ud-td-row">
                <span>${esc(chainName(s.networkId || s.inNetworkId))} · ${esc(s.provider || "swap")}</span>
                <b>${fmtUsd(s.humanUsdAmountIn || s.humanUsdAmountOut)}</b>
              </div>
              <div class="ud-td-row ud-td-addr"><span>执行地址</span>
                <b>${esc(shortAddr(s.address, 8))} <button class="copy-btn" data-copy="${esc(s.address)}" title="复制">📋</button>
                ${explorerLink(s.networkId || s.inNetworkId, s.address) ? `<a href="${explorerLink(s.networkId || s.inNetworkId, s.address)}" target="_blank">链上↗</a>` : ""}
              </b></div>`;
            });
          }
          const transfers = d.transfers || [];
          if (transfers.length) {
            html += `<div class="ud-td-sec">链上转账（${transfers.length}）</div>`;
            transfers.slice(0, 6).forEach((t) => {
              html += `<div class="ud-td-row ud-td-addr"><span>${esc(t.type || "transfer")}</span>
                <b>${esc(shortAddr(t.fromAddress, 6))} → ${esc(shortAddr(t.toAddress, 6))} · ${fmtUsd(t.usdAmount)}
                <button class="copy-btn" data-copy="${esc(t.fromAddress)}" title="复制from">📋</button>
                <button class="copy-btn" data-copy="${esc(t.toAddress)}" title="复制to">📋</button></b></div>`;
            });
          }
          if (d.comment) {
            const c = d.comment.comment || d.comment.text || "";
            if (c) html += `<div class="ud-td-sec">评论</div><div class="ud-td-row"><span>${esc(c)}</span></div>`;
          }
          detailEl.innerHTML = html || `<div class="ud-empty">无明细</div>`;

          // 更新链上活动地址区
          const onEl = b.querySelector("#udOnchain");
          if (onEl) {
            const seen = new Set();
            const addrs = [];
            if (tr.userAddress && !seen.has(tr.userAddress)) {
              seen.add(tr.userAddress);
              addrs.push({ label: "交易账户", chainLabel: chainName(tr.networkId), addr: tr.userAddress, nid: tr.networkId });
            }
            swaps.forEach((s) => { if (s.address && !seen.has(s.address)) { seen.add(s.address); addrs.push({ label: "Swap执行", chainLabel: chainName(s.networkId || s.inNetworkId), addr: s.address, nid: s.networkId || s.inNetworkId }); } });
            transfers.forEach((t) => {
              [t.fromAddress, t.toAddress].forEach((a) => { if (a && !seen.has(a)) { seen.add(a); addrs.push({ label: "链上转账", chainLabel: chainName(t.networkId), addr: a, nid: t.networkId }); } });
            });
            onEl.innerHTML = addrs.length ? addrsHTML(u, addrs) : `<div class="ud-empty">暂无链上活动地址</div>`;
            annotateAddrs(onEl);
          }
        } catch (e) {
          if (!silent) detailEl.innerHTML = `<div class="ud-empty">加载失败：${esc(e.message || String(e))}</div>`;
        }
      }

      const rows = Array.from(el.querySelectorAll(".ud-trade"));
      rows.forEach((row) => row.addEventListener("click", () => expandTrade(row, false)));
      // 静默预取前 2 笔交易详情 → 建立"实际链上地址 → 用户"反查索引
      rows.slice(0, 2).forEach((row) => expandTrade(row, true));
    });
  }

  /* ============ 全局点击：打开用户详情 ============ */
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-uid]");
    if (!el) return;
    e.preventDefault();
    const uid = el.dataset.uid;
    const userObj = el.dataset.user ? JSON.parse(el.dataset.user) : undefined;
    openUserDrawer(uid, userObj);
  });

  /* ============ 导出 ============ */
  window.__fomoUser = { openUserDrawer, indexUser, indexTradeAddrs, getIndex: () => window.__addrIndex, addMyLib, removeMyLib, getMyLib };
})();
