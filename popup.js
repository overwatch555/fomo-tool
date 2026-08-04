/* FOMO 看板 - popup 快捷面板 */
(() => {
  const body = document.getElementById("body");
  let tab = "leaderboard";

  async function api(path, options) {
    const r = await chrome.runtime.sendMessage({ action: "call", path, options });
    if (!r || !r.ok) throw new Error(r ? r.error : "无响应");
    if (!r.r.ok) throw new Error("HTTP " + r.r.status);
    return r.r.data;
  }

  async function refreshStatus() {
    const s = await chrome.runtime.sendMessage({ action: "getSession" });
    const el = document.getElementById("status");
    const tx = document.getElementById("statusText");
    let live = false;
    try {
      const rt = await chrome.runtime.sendMessage({ action: "getRealtime" });
      live = !!(rt && rt.ok && rt.connected);
    } catch (_e) {}
    if (s && s.ok && s.session.jwt) {
      el.className = "status ok";
      tx.textContent = (s.session.userName || "已登录") + (live ? " · 实时" : " · 轮询");
    } else {
      el.className = "status";
      tx.textContent = "未登录";
    }
  }

  function itemHTML(inner) {
    return `<div class="item">${inner}</div>`;
  }

  async function load() {
    body.innerHTML = '<div class="empty">加载中…</div>';
    try {
      if (tab === "leaderboard") {
        const d = await api("/v2/leaderboard?limit=50");
        const list = d.responseObject && d.responseObject.leaderboard || [];
        body.innerHTML = list.slice(0, 8).map((u, i) => itemHTML(`
          ${u.profilePictureLink ? `<img src="${esc(u.profilePictureLink)}">` : `<div class="avatar">#${i + 1}</div>`}
          <div class="main">
            <div class="name">${esc(u.displayName || u.userHandle || "匿名")}</div>
            <div class="sub">@${esc(u.userHandle || "")} · ${fmtNum(u.followers)}粉 · ${fmtNum(u.numTrades, 0)}笔${u.totalHoldings != null ? ` · 📦${fmtNum(u.totalHoldings, 0)}币` : ""}</div>
            ${addrChip(u)}
          </div>
          <div class="right">
            <div class="r1 ${pctClass(u.pnl24h)}">${u.pnl24h > 0 ? "+" : ""}${fmtUsd(u.pnl24h)}</div>
            <div class="r2">24h盈亏</div>
          </div>`)).join("") || '<div class="empty">暂无数据</div>';
      } else if (tab === "signals") {
        const items = await taSignal(); // 走后台统一缓存，避免 429
        body.innerHTML = items.slice(0, 10).map((s) => itemHTML(`
          ${s.profilePictureLink ? `<img src="${esc(s.profilePictureLink)}">` : `<div class="avatar">F</div>`}
          <div class="main">
            <div class="name">${esc(s.displayName || s.userHandle || "匿名")} <span class="sub">· ${esc(signLabel(s.type))}</span></div>
            <div class="sub">${esc(s.ticker || shortAddr(s.tokenAddress))} · ${esc(chainName(s.networkId))}</div>
          </div>
          <div class="right"><div class="r2">${timeAgo(s.createdAt)}</div></div>`)).join("") || '<div class="empty">暂无信号</div>';
      } else {
        // 热门：优先 WS 实时缓存
        let list = null;
        try {
          const rt = await chrome.runtime.sendMessage({ action: "getRealtime" });
          if (rt && rt.ok && rt.list && rt.list.length) list = rt.list;
        } catch (_e) {}
        if (!list) {
          const d = await api("/proxy/trendingTokens", { method: "POST" });
          list = Array.isArray(d.responseObject) ? d.responseObject : (d.responseObject && d.responseObject.tokens) || [];
        }
        body.innerHTML = list.slice(0, 10).map((t) => {
          const tok = t.token || {};
          const img = (tok.info && (tok.info.imageThumbUrl || tok.info.imageSmallUrl)) || "";
          const c24 = Number(t.change24 || 0);
          return itemHTML(`
            ${img ? `<img src="${esc(img)}">` : `<div class="avatar">T</div>`}
            <div class="main">
              <div class="name">${esc(tok.symbol || "-")}</div>
              <div class="sub">${fmtUsd(Number(t.volume24))} vol · ${fmtNum(t.holders, 0)} holders</div>
            </div>
            <div class="right">
              <div class="r1 ${pctClass(c24)}">${fmtPct(c24)}</div>
              <div class="r2">${fmtPrice(Number(t.priceUSD))}</div>
            </div>`);
        }).join("") || '<div class="empty">暂无数据</div>';
      }
    } catch (e) {
      body.innerHTML = `<div class="err">${esc(e.message)}<br><br>请点击「打开完整看板」检查登录状态</div>`;
    }
  }

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      tab = t.dataset.tab;
      load();
    });
  });

  document.getElementById("refreshBtn").addEventListener("click", () => { refreshStatus(); load(); });
  document.getElementById("exportWalletsBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const old = btn.textContent;
    try {
      const n = await exportRealWallets();
      btn.textContent = `✓ ${n} 个`;
      btn.disabled = true;
      setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1800);
    } catch (_e) {
      btn.textContent = "✗ 失败";
      setTimeout(() => { btn.textContent = old; }, 1800);
    }
  });
  document.getElementById("dashboardBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  /* 快速搜索：跳转看板并自动执行搜索 */
  function openSearch(q) {
    q = (q || "").trim();
    if (!q) return;
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") + "?q=" + encodeURIComponent(q) });
    window.close();
  }
  document.getElementById("searchBtn").addEventListener("click", () => openSearch(document.getElementById("searchInput").value));
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") openSearch(e.target.value);
  });

  refreshStatus();
  load();
  setInterval(() => { if (document.visibilityState === "visible") load(); }, 30000);
})();
