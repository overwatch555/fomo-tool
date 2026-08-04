/* FOMO 看板 - 主逻辑 */
(() => {
  const $ = (sel) => document.querySelector(sel);

  let autoRefresh = true;
  let refreshTimer = null;
  let trendingIsLive = false;
  let latestLeaderboard = [];
  let latestSignals = [];
  let latestFeed = [];
  let currentSigFilter = "all";
  let currentFeedFilter = "all";
  let topSignalThreshold = 30;
  const AUTO_MS = 15000; // 排行榜/信号/Feed 轮询间隔（热门币走 WS 实时）

  /* ---------- 会话状态 ---------- */
  function updateLivePill(connected) {
    const pill = $("#livePill");
    const txt = $("#liveText");
    if (connected) {
      pill.className = "session-pill ok";
      txt.textContent = "实时已连接";
    } else {
      pill.className = "session-pill";
      txt.textContent = "实时未连接";
    }
  }

  async function refreshSessionUI() {
    const r = await chrome.runtime.sendMessage({ action: "getSession" });
    const pill = $("#sessionPill");
    const txt = $("#sessionText");
    if (r && r.ok && r.session.jwt) {
      pill.className = "session-pill ok";
      const name = r.session.userName || "已登录";
      const uid = r.session.userId ? ` · ${r.session.userId.slice(0, 8)}` : "";
      txt.textContent = `${name}${uid}`;
    } else {
      pill.className = "session-pill bad";
      txt.textContent = "未登录（点击⚙会话）";
    }
  }

  /* ---------- API 封装 ---------- */
  async function api(path, options) {
    const r = await chrome.runtime.sendMessage({
      action: "call",
      path,
      options,
    });
    if (!r || !r.ok) {
      const err = r ? r.error : "background 无响应";
      throw new Error(err);
    }
    if (!r.r.ok) {
      if (r.r.status === 401) throw new Error("JWT 已过期");
      if (r.r.status === 403) throw new Error("被 Cloudflare 拦截");
      throw new Error("HTTP " + r.r.status);
    }
    return r.r.data;
  }

  /* ---------- 渲染 ---------- */
  /* 库用户匹配(自研 151 人地址库): 优先 userId, 兜底 handle */
  function findLibUser(u) {
    if (!window.__userCache) return null;
    let cu = u && u.id ? window.__userCache.get(u.id) : null;
    if (cu) return cu;
    const h = u && (u.userHandle || u.handle);
    if (h) cu = window.__userCache.get("h:" + h.toLowerCase());
    return cu || null;
  }
  function libBadge(cu) {
    if (!cu) return `<span class="fp-badge fp-eoa" title="未在自研库,地址待反查">未反查</span>`;
    return cu._evmReal || cu._solReal
      ? `<span class="fp-badge fp-real" title="自研库已反查,有真实钱包">✅真实钱包</span>`
      : `<span class="fp-badge fp-fake" title="仅平台展示地址">⚠️展示</span>`;
  }

  function renderLeaderboard(list) {
    const tb = $("#lbBody");
    tb.innerHTML = "";
    if (!list || !list.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
      return;
    }
    list.slice(0, 50).forEach((u, i) => {
      const tr = document.createElement("tr");
      const avatar = u.profilePictureLink
        ? `<img class="avatar" src="${esc(u.profilePictureLink)}">`
        : `<div class="avatar"></div>`;
      const lbUser = findLibUser(u);
      const realLine = lbUser && (lbUser._evmReal || lbUser._solReal)
        ? `<div class="lib-real">真实钱包 ${lbUser._evmReal ? "EVM " + esc(lbUser._evmReal.slice(0, 8)) + "…" : ""}${lbUser._solReal ? " SOL " + esc(lbUser._solReal.slice(0, 8)) + "…" : ""}</div>`
        : "";
      tr.innerHTML = `
        <td class="muted">#${i + 1}</td>
        <td><div class="trader clickable-user" data-uid="${esc(u.id)}" title="点击查看用户详情">${avatar}<div>
          <div class="name">${esc(u.displayName || u.userHandle || "匿名")} ${libBadge(lbUser)}</div>
          <div class="handle">@${esc(u.userHandle || shortAddr(u.address))}</div>
          ${realLine}
          ${addrChip(u)}
        </div></div></td>
        <td>${fmtNum(u.followers)}</td>
        <td>${fmtNum(u.numTrades, 0)}</td>
        <td>${fmtUsd(u.totalVolume)}</td>
        <td class="${pctClass(u.pnl24h)}">${u.pnl24h > 0 ? "+" : ""}${fmtUsd(u.pnl24h)}</td>
        <td>${holdingsCell(u)}</td>`;
      tb.appendChild(tr);
    });
  }

  /* 排行榜"持仓代币"列：优先展示 topHoldings 币种，缺失时回退数量 */
  function holdingsCell(u) {
    const th = u.topHoldings;
    if (Array.isArray(th) && th.length) {
      const chips = th
        .slice(0, 3)
        .map((h) => {
          const sym = (h.tokenAddress || "").slice(0, 5);
          const img = h.imageUrl || "";
          return `<span class="hold-chip" title="${esc(h.tokenAddress || "")}">${img ? `<img src="${esc(img)}">` : ""}${esc(sym)}</span>`;
        })
        .join("");
      const more =
        th.length > 3 ? `<span class="hold-more">+${th.length - 3}</span>` : "";
      return `<div class="hold-tokens" title="持仓 ${fmtNum(u.totalHoldings, 0)} 个代币 · 点击用户查看全部">${chips}${more}</div>`;
    }
    const n = u.totalHoldings;
    return `<span class="muted">${n != null ? fmtNum(n, 0) + " 个" : "-"}</span>`;
  }

  function signalAction(s) {
    const type = String(s.type || s.feedType || "").toLowerCase();
    if (type.includes("buy")) return { label: "买入", cls: "buy" };
    if (type.includes("sell") || type.includes("close")) return { label: "卖出", cls: "sell" };
    return { label: signLabel(s.type), cls: "new" };
  }

  function signalToken(s) {
    const b = s.body || {};
    const token = s.token || b.token || {};
    return {
      address: s.tokenAddress || b.tokenAddress || token.address || "",
      symbol: s.ticker || s.tokenSymbol || b.tokenSymbol || token.symbol || "",
      name: s.tokenName || b.tokenName || token.name || "",
      image: s.tokenImageUrl || token.imageUrl || (token.info && (token.info.imageThumbUrl || token.info.imageSmallUrl)) || "",
      networkId: s.networkId || b.networkId || token.networkId,
    };
  }

  function holdingsSummary(user, signal) {
    const hs = (user && user.topHoldings) || [];
    const liveAmount = signal && (signal.humanTokenAmount ?? signal.currentTokenAmount ?? signal.tokenAmount);
    const liveValue = signal && (signal.usdValue ?? signal.currentUsdValue);
    if (liveAmount !== undefined && liveAmount !== null) {
      return `<div class="position-current"><span>本币持仓</span><b>${fmtAmount(liveAmount)} ${esc(signal.ticker || "")}</b>${liveValue ? `<small>${fmtUsd(liveValue)}</small>` : ""}</div>`;
    }
    if (Array.isArray(hs) && hs.length) {
      const chips = hs.slice(0, 3).map((h) => {
        const symbol = h.symbol || h.ticker || shortAddr(h.tokenAddress, 4) || "?";
        return `<span class="position-chip" title="${esc(h.tokenAddress || symbol)}">${esc(symbol)}</span>`;
      }).join("");
      const more = hs.length > 3 ? `<span class="position-more">+${hs.length - 3}</span>` : "";
      const count = user.totalHoldings != null ? `${fmtNum(user.totalHoldings, 0)} 币` : "持仓";
      return `<div class="position-summary" title="点击交易者可查看完整持仓"><span class="position-count">${count}</span><div>${chips}${more}</div></div>`;
    }
    return `<span class="muted">暂无持仓</span>`;
  }

  function renderSignals(list) {
    const tb = $("#sigBody");
    if (!tb) return;
    tb.innerHTML = "";
    const usersById = new Map(latestLeaderboard.map((u) => [u.id, u]));

    // 过滤逻辑: all / top / top_buy
    const rows = (list || []).filter((s) => {
      const tt = (s.body && Array.isArray(s.body.topTraders) && s.body.topTraders[0]) || {};
      const u = usersById.get(s.userId || tt.id);
      const rank = u ? latestLeaderboard.indexOf(u) + 1 : 0;
      const isTop = Boolean(rank && rank <= topSignalThreshold);
      const action = signalAction(s);

      if (currentSigFilter === "top") return isTop;
      if (currentSigFilter === "top_buy") return isTop && action.cls === "buy";
      return true; // "all"
    });

    const topBuyCount = (list || []).filter((s) => {
      const tt = (s.body && Array.isArray(s.body.topTraders) && s.body.topTraders[0]) || {};
      const u = usersById.get(s.userId || tt.id);
      const rank = u ? latestLeaderboard.indexOf(u) + 1 : 0;
      return rank && rank <= topSignalThreshold && signalAction(s).cls === "buy";
    }).length;

    const countBadge = $("#sigCountBadge");
    if (countBadge) countBadge.textContent = `${rows.length} 条`;

    const meta = $("#sigMeta");
    if (meta) meta.textContent = `近 100 条信号 · Top ${topSignalThreshold} 榜单买入 ${topBuyCount} 条（已合并推送提醒）`;

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="6" class="empty">${currentSigFilter === "all" ? "暂无跟单信号" : "暂无符合条件的 Top 50 信号"}</td></tr>`;
      return;
    }

    const jobs = []; // 异步翻译任务
    rows.slice(0, 50).forEach((s, i) => {
      const tr = document.createElement("tr");
      // tradingActivity 的用户在嵌套 body.topTraders[]（顶层 userId 常为 null）→ 去匿名
      const tt = (s.body && Array.isArray(s.body.topTraders) && s.body.topTraders[0]) || {};
      const sigUid = s.userId || tt.id;
      const leaderboardUser = usersById.get(sigUid) || {};
      const rank = leaderboardUser.id ? latestLeaderboard.indexOf(leaderboardUser) + 1 : 0;
      const action = signalAction(s);
      const token = signalToken(s);
      const sigUser = Object.assign({}, leaderboardUser, {
        id: sigUid,
        displayName: s.displayName || tt.displayName,
        userHandle: s.userHandle || tt.userHandle,
        profilePictureLink: s.profilePictureLink || tt.userImageUrl,
        networkId: s.networkId,
      });
      const avatar = sigUser.profilePictureLink
        ? `<img class="avatar" src="${esc(sigUser.profilePictureLink)}">`
        : `<div class="avatar"></div>`;
      const tokImg = token.image ? `<img src="${esc(token.image)}">` : "";
      const comment = (s.comment && (s.comment.comment || s.comment.text)) || "";
      if (window.__fomoUser) window.__fomoUser.indexUser(sigUser);

      const topAlert = rank && rank <= topSignalThreshold && action.cls === "buy"
        ? `<span class="top-signal-alert">⚡ Top ${rank} 跟单提醒</span>` : "";

      tr.innerHTML = `
        <td>
          <div class="trader clickable-user" data-uid="${esc(sigUid || "")}" title="点击查看交易者详情">
            ${avatar}
            <div>
              <div class="name">${esc(sigUser.displayName || sigUser.userHandle || "匿名天团")} ${libBadge(findLibUser(sigUser))}${rank ? `<span class="rank-badge" title="排行榜第 ${rank} 名">#${rank}</span>` : ""}</div>
              <div class="handle">@${esc(sigUser.userHandle || "")}</div>
            </div>
          </div>
        </td>
        <td>
          <span class="badge ${action.cls}">${esc(action.label)}</span>
          ${topAlert}
        </td>
        <td>
          <div class="token-cell">
            ${tokImg}
            <div>
              <div class="sym">${esc(token.symbol || shortAddr(token.address) || "未知代币")} <span class="position-more">${esc(chainName(token.networkId))}</span></div>
              <div class="name2">${esc(token.name || "未定义代币全称")}</div>
              ${token.address ? `
                <div class="token-address">
                  <span title="完整合约地址: ${esc(token.address)}">CA: ${esc(shortAddr(token.address, 6))}</span>
                  <button class="copy-btn" data-copy="${esc(token.address)}" title="点击复制代币地址 (CA)">📋</button>
                </div>` : ""}
            </div>
          </div>
        </td>
        <td>${holdingsSummary(leaderboardUser, s)}</td>
        <td>
          <div class="signal-detail">
            ${comment ? `<div class="comment" data-tr-key="sig${i}" title="${esc(comment)}">${esc(comment)}</div>` : ""}
            ${s.usdAmount ? `<span class="signal-value ${action.cls === "buy" ? "up" : action.cls === "sell" ? "down" : ""}">${fmtUsd(s.usdAmount)}</span>` : ""}
            ${s.price ? `<span class="signal-price">@${fmtPrice(s.price)}</span>` : ""}
          </div>
        </td>
        <td class="muted">${timeAgo(s.createdAt)}</td>`;
      tb.appendChild(tr);
      if (comment) {
        const el = tb.querySelector(`[data-tr-key="sig${i}"]`);
        if (el) jobs.push([el, comment]);
      }
    });

    if (jobs.length && window.translateInto) translateInto(tb, jobs);
  }

  function renderTrending(list, isLive) {
    const tb = $("#trdBody");
    tb.innerHTML = "";
    if (isLive !== undefined) {
      trendingIsLive = isLive;
      const badge = document.getElementById("trendingBadge");
      if (badge) badge.style.display = isLive ? "" : "none";
    }
    if (!list || !list.length) {
      tb.innerHTML = '<tr><td colspan="9" class="empty">暂无数据</td></tr>';
      return;
    }
    list.slice(0, 50).forEach((t) => {
      const tok = t.token || {};
      const img =
        (tok.info && tok.info.imageThumbUrl) ||
        (tok.info && tok.info.imageSmallUrl) ||
        "";
      const c1 = Number(t.change1 || 0),
        c24 = Number(t.change24 || 0);
      const b24 = Number(t.buyCount24 || 0),
        s24 = Number(t.sellCount24 || 0);
      const ratio = s24 > 0 ? (b24 / s24).toFixed(2) : b24 > 0 ? "∞" : "-";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div class="token-cell"><img src="${esc(img)}"><div>
          <div class="sym">${esc(tok.symbol || "-")}</div>
          <div class="name2">${esc(tok.name || "")}</div>
        </div></div></td>
        <td>${fmtPrice(Number(t.priceUSD))}</td>
        <td class="${pctClass(c1)}">${fmtPct(c1)}</td>
        <td class="${pctClass(c24)}">${fmtPct(c24)}</td>
        <td>${fmtUsd(Number(t.volume24))}</td>
        <td>${fmtUsd(Number(t.marketCap))}</td>
        <td>${fmtNum(t.holders, 0)}</td>
        <td>${ratio}</td>
        <td class="muted">${esc(chainName(tok.networkId))}</td>`;
      tb.appendChild(tr);
    });
  }

  function renderFeed(list) {
    const tb = $("#feedBody");
    if (!tb) return;
    tb.innerHTML = "";

    const feedList = Array.isArray(list) ? list : latestFeed;
    if (!feedList || !feedList.length) {
      tb.innerHTML = '<div class="empty">暂无交易动态</div>';
      return;
    }

    // 过滤逻辑: all / collective / new_token / thesis / milestone
    const filtered = feedList.filter((f) => {
      const body = typeof f.body === "object" && f.body ? f.body : {};
      const rawType = String(f.feedType || body.feedType || f.type || "").toLowerCase();

      if (currentFeedFilter === "collective") {
        return rawType.includes("multi_user") || rawType.includes("smart_following") || (Array.isArray(body.users) && body.users.length > 0);
      }
      if (currentFeedFilter === "new_token") {
        return rawType.includes("new_token") || rawType.includes("price_since") || rawType.includes("listing");
      }
      if (currentFeedFilter === "thesis") {
        return rawType.includes("thesis") || rawType.includes("manual");
      }
      if (currentFeedFilter === "milestone") {
        return rawType.includes("milestone") || rawType.includes("profit") || body.pnl != null;
      }
      return true; // "all"
    });

    const countBadge = $("#feedCountBadge");
    if (countBadge) countBadge.textContent = `${filtered.length} 条`;

    if (!filtered.length) {
      tb.innerHTML = '<div class="empty">该分类下暂无动态</div>';
      return;
    }

    const jobs = []; // 异步翻译任务

    filtered.slice(0, 50).forEach((f, i) => {
      const item = document.createElement("article");
      const body = typeof f.body === "object" && f.body ? f.body : {};
      const rawType = f.feedType || body.feedType || f.type || "";
      const typeLabel = feedTypeLabel(rawType);

      // 颜色 rail 样式判定
      let railCls = "new";
      if (/buy/i.test(rawType)) railCls = "buy";
      else if (/sell/i.test(rawType)) railCls = "sell";
      else if (/milestone|profit/i.test(rawType)) railCls = "milestone";

      const detailText = feedBodyText(f);
      const token = signalToken(Object.assign({}, f, body));

      // 用户信息解析 (支持多用户 collective buy)
      const isMultiUser = Array.isArray(body.users) && body.users.length > 0;
      let userHeaderHTML = "";

      if (isMultiUser) {
        const avatars = body.users.slice(0, 4).map((u) => {
          const img = u.profilePictureLink || "";
          return img
            ? `<img src="${esc(img)}" title="${esc(u.displayName || u.userHandle || "")}">`
            : `<div class="avatar"></div>`;
        }).join("");
        userHeaderHTML = `
          <div class="activity-top-users">
            <div class="avatar-stack">${avatars}</div>
            <div class="activity-title">👥 ${esc(body.users.length)} 位大V / 交易者联合行动</div>
          </div>`;
      } else {
        const uid = f.userId || body.userId || (f.user && f.user.id);
        const name = f.displayName || body.displayName || (f.user && (f.user.displayName || f.user.userHandle)) || "全网交易员";
        const rankUser = latestLeaderboard.find((u) => u.id === uid);
        const rank = rankUser ? latestLeaderboard.indexOf(rankUser) + 1 : 0;
        const avatar = f.profilePictureLink || (f.user && f.user.profilePictureLink);
        const avatarHTML = avatar
          ? `<img class="avatar" src="${esc(avatar)}">`
          : `<div class="avatar"></div>`;

        userHeaderHTML = `
          <div class="activity-title ${uid ? "clickable-user" : ""}" ${uid ? `data-uid="${esc(uid)}" title="点击查看交易者详情"` : ""}>
            ${avatarHTML}
            <span>${esc(name)}</span>
            ${rank ? `<span class="rank-badge" title="排行榜第 ${rank} 名">#${rank}</span>` : ""}
          </div>`;
      }

      const amount = body.amountInUsd ?? f.amountInUsd ?? f.usdAmount ?? body.totalAmountUsd;
      const price = body.price ?? f.price ?? body.entryPrice;
      const pnl = body.pnl;

      item.className = "activity-card";
      item.innerHTML = `
        <div class="activity-rail ${railCls}"></div>
        <div class="activity-main">
          <div class="activity-top">
            <span class="badge ${railCls}">${esc(typeLabel)}</span>
            <span class="activity-time">${timeAgo(f.createdAt)}</span>
          </div>
          ${userHeaderHTML}
          <div class="activity-detail" data-tr-key="feed${i}" title="${esc(detailText)}">${esc(detailText)}</div>
        </div>
        <div class="activity-token">
          <div class="sym">
            ${esc(token.symbol || shortAddr(token.address) || "未知代币")}
            ${token.networkId ? `<span class="position-more">${esc(chainName(token.networkId))}</span>` : ""}
          </div>
          <div class="name2">${esc(token.name || "未关联全称")}</div>
          ${token.address ? `
            <div class="token-address">
              <span title="CA: ${esc(token.address)}">CA: ${esc(shortAddr(token.address, 6))}</span>
              <button class="copy-btn" data-copy="${esc(token.address)}" title="复制代币地址 (CA)">📋</button>
            </div>` : ""}
        </div>
        <div class="activity-numbers">
          ${amount !== undefined && amount !== null ? `<b>${fmtUsd(amount)}</b>` : ""}
          ${pnl !== undefined && pnl !== null ? `<span class="${pctClass(pnl)}">${pnl > 0 ? "+" : ""}盈亏 ${fmtUsd(pnl)}</span>` : ""}
          ${price ? `<span>@${fmtPrice(price)}</span>` : ""}
        </div>`;

      tb.appendChild(item);

      if (detailText && window.needTranslate && window.needTranslate(detailText)) {
        const el = tb.querySelector(`[data-tr-key="feed${i}"]`);
        if (el) jobs.push([el, detailText]);
      }
    });

    if (jobs.length && window.translateInto) translateInto(tb, jobs);
  }

  /* ---------- 数据加载 ---------- */
  let loading = false;
  async function loadAll() {
    if (loading) return;
    loading = true;
    const btn = $("#refreshBtn");
    btn.disabled = true;
    btn.textContent = "加载中…";
    try {
      const [lb, sigItems] = await Promise.all([
        api("/v2/leaderboard?limit=50"),
        taSignal(), // 走后台统一缓存，不再直接请求 tradingActivity（防 429）
      ]);
      const lbList = (lb.responseObject && lb.responseObject.leaderboard) || [];
      const sigList = Array.isArray(sigItems) ? sigItems : [];
      latestLeaderboard = lbList;
      latestSignals = sigList;
      // 建立 用户/地址 索引（供点击详情 + 地址反查）
      if (window.__fomoUser) {
        lbList.forEach((u) => window.__fomoUser.indexUser(u));
        sigList.forEach(
          (s) =>
            s.userId &&
            window.__fomoUser.indexUser({
              id: s.userId,
              displayName: s.displayName,
              userHandle: s.userHandle,
              profilePictureLink: s.profilePictureLink,
              networkId: s.networkId,
            }),
        );
      }
      renderLeaderboard(lbList);
      renderSignals(sigList);
      // 热门币：优先用 WS 实时缓存，无缓存时退回 REST
      let trdList = null;
      let trendingLive = false;
      try {
        const rt = await chrome.runtime.sendMessage({ action: "getRealtime" });
        if (rt && rt.ok && rt.list && rt.list.length) {
          trdList = rt.list;
          trendingLive = true;
        }
        updateLivePill(rt && rt.connected);
      } catch (_e) {}
      if (!trdList) {
        const trd = await api("/proxy/trendingTokens", { method: "POST" });
        trdList = Array.isArray(trd.responseObject)
          ? trd.responseObject
          : trd.responseObject && trd.responseObject.tokens;
      }
      renderTrending(trdList, trendingLive);
      computeStats(lb, sigItems, trdList);
      try {
        const feed = await api("/feed", {
          params: {
            limit: 50,
            feedTypes: [
              "manual",
              "multi_user_buy",
              "multi_user_sell",
              "new_token_listing",
              "price_since_listing",
              "user_trade_profit_milestone",
              "thesis_created",
              "user_with_smart_following",
            ],
          },
        });
        latestFeed = (feed.responseObject && feed.responseObject.feed) || [];
        renderFeed(latestFeed);
      } catch (_) {
        latestFeed = [];
        renderFeed(null);
      }
    } catch (e) {
      const msg = /NO_JWT/.test(e.message || "")
        ? "未登录：请点击 ⚙ 会话 → 打开 fomo.family 登录一次（扩展自动捕获），或手动粘贴 JWT"
        : `${esc(e.message || "加载失败")} — 请点击 ⚙ 会话 检查登录状态`;
      ["lbBody", "sigBody", "trdBody"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<tr><td colspan="9" class="error">${msg}</td></tr>`;
      });
      const fb = document.getElementById("feedBody");
      if (fb) fb.innerHTML = `<div class="error">${msg}</div>`;
    } finally {
      loading = false;
      btn.disabled = false;
      btn.textContent = "⟳ 刷新";
    }
  }

  function computeStats(lb, sig, trdList) {
    const list = (lb.responseObject && lb.responseObject.leaderboard) || [];
    const pnlSum = list.reduce((a, u) => a + Number(u.pnl24h || 0), 0);
    const volSum = list.reduce((a, u) => a + Number(u.totalVolume || 0), 0);
    $("#statPnlSum").textContent = (pnlSum >= 0 ? "+" : "") + fmtUsd(pnlSum);
    $("#statPnlSum").className = "value " + pctClass(pnlSum);
    $("#statVolumeSum").textContent = fmtUsd(volSum);

    const items = Array.isArray(sig) ? sig : []; // taSignal 已返回 items 数组
    const hourAgo = Date.now() - 3600 * 1000;
    $("#statSignals").textContent = items.filter(
      (s) => new Date(s.createdAt).getTime() > hourAgo,
    ).length;

    if (trdList && trdList.length) {
      let best = trdList[0];
      for (const t of trdList)
        if (Number(t.change24 || 0) > Number(best.change24 || 0)) best = t;
      const tok = best.token || {};
      $("#statTopGain").textContent = fmtPct(Number(best.change24 || 0));
      $("#statTopGainName").textContent = `${tok.symbol || "-"} · 24h`;
    }
  }

  /* ---------- WS 实时监听 ---------- */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (changes.trendingRealtime) {
      const v = changes.trendingRealtime.newValue;
      if (v && v.list && v.list.length) renderTrending(v.list, true);
    }
    if (changes.wsConnected) {
      updateLivePill(changes.wsConnected.newValue);
    }
  });

  /* ---------- 页签 ---------- */
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document
        .querySelectorAll(".tab")
        .forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      document
        .querySelectorAll(".tabview")
        .forEach((v) => (v.style.display = "none"));
      $("#" + t.dataset.tab).style.display = "";
    });
  });

  /* ---------- 信号与动态切分按钮事件 ---------- */
  document.querySelectorAll(".filter-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentSigFilter = btn.dataset.sigFilter || "all";
      renderSignals(latestSignals);
    });
  });

  document.querySelectorAll(".feed-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".feed-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFeedFilter = btn.dataset.feedFilter || "all";
      renderFeed(latestFeed);
    });
  });

  /* ---------- 控制 ---------- */
  $("#refreshBtn").addEventListener("click", () => {
    refreshSessionUI();
    loadAll();
  });
  $("#autoToggle").addEventListener("change", (e) => {
    autoRefresh = e.target.checked;
    if (autoRefresh) startAuto();
    else stopAuto();
  });

  function startAuto() {
    stopAuto();
    refreshTimer = setInterval(() => {
      loadAll();
    }, AUTO_MS);
  }
  function stopAuto() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  /* ---------- 会话弹窗 ---------- */
  const modal = $("#settingsModal");
  $("#settingsBtn").addEventListener("click", () => {
    refreshSessionUI();
    modal.classList.add("show");
  });
  $("#closeModalBtn").addEventListener("click", () =>
    modal.classList.remove("show"),
  );
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("show");
  });

  $("#openFomoBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://fomo.family" });
  });

  $("#saveJwtBtn").addEventListener("click", async () => {
    const jwt = $("#jwtInput").value.trim();
    if (!jwt) return;
    // 尝试解析 userId
    let userId = "";
    try {
      const seg = jwt.split(".")[1];
      const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
      const p = JSON.parse(decodeURIComponent(escape(atob(b64))));
      userId = p.sub || "";
    } catch (_) {}
    await chrome.runtime.sendMessage({ action: "setJwt", jwt, userId });
    $("#jwtInput").value = "";
    refreshSessionUI();
    loadAll();
  });

  $("#clearSessionBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ action: "clearSession" });
    refreshSessionUI();
  });

  /* ---------- 推送设置 ---------- */
  const pushToggle = $("#pushToggle");
  const pushTopN = $("#pushTopN");
  chrome.storage.local.get(["pushEnabled", "pushTopN"]).then((c) => {
    if (pushToggle) pushToggle.checked = c.pushEnabled !== false;
    topSignalThreshold = c.pushTopN || 30;
    if (pushTopN) pushTopN.value = topSignalThreshold;
    renderSignals(latestSignals);
  });
  if (pushToggle) {
    pushToggle.addEventListener("change", () => {
      chrome.storage.local.set({ pushEnabled: pushToggle.checked });
    });
  }
  if (pushTopN) {
    pushTopN.addEventListener("change", () => {
      const v = Math.min(50, Math.max(1, Number(pushTopN.value) || 30));
      pushTopN.value = v;
      topSignalThreshold = v;
      chrome.storage.local.set({ pushTopN: v });
      renderSignals(latestSignals);
    });
  }
  // 后台推送 → 看板显示最近推送
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "topBuyPush" && window.__fomoSearch) {
      const box = document.getElementById("pushTest");
      if (!box) return;
      box.style.display = "";
      const s = msg.sig || {};
      const line = `${esc(s.displayName || "")} 买入 ${esc(s.ticker || "")} · ${msg.rank ? "#" + msg.rank : ""}`;
      const item = document.createElement("div");
      item.className = "push-item";
      item.textContent = line + " · " + timeAgo(s.createdAt);
      box.prepend(item);
      while (box.children.length > 8) box.lastChild.remove();
    }
  });

  /* ---------- 启动 ---------- */
  if (window.__fomoSearch) {
    window.__fomoSearch.bind();
    // 支持从 popup 快速搜索跳转：?q=<查询词> 自动执行
    const q = new URLSearchParams(location.search).get("q");
    if (q && window.__fomoSearch.run) {
      const input = document.getElementById("searchInput");
      if (input) input.value = q;
      window.__fomoSearch.run(q);
    }
  }
  refreshSessionUI();
  loadAll();
  startAuto();
})();
