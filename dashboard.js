/* FOMO 看板 - 主逻辑 */
(() => {
  const $ = (sel) => document.querySelector(sel);

  let autoRefresh = true;
  let refreshTimer = null;
  let trendingIsLive = false;
  let latestLeaderboard = [];
  let latestSignals = [];
  let latestFeed = [];
  let latestThesis = []; // feed 观点条目（thesis_created/manual），合并进跟单信号
  let currentSigFilter = "all";
  let currentFeedFilter = "all";
  let currentWatchFilter = "all";
  let topSignalThreshold = 30;
  let watchTopN = 30; // Top 榜前 N 名自动并入关注列表（动态，不持久化）
  let pushMinUsdThreshold = 200; // 任何代币单笔金额阈值（与设置联动，默认 $200）
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

  /* ---------- 关注列表（Watchlist）监控判定 ---------- */
  /* uid 在排行榜中的名次（0 = 不在榜） */
  function rankOfUser(uid) {
    if (!uid) return 0;
    const u = latestLeaderboard.find((x) => x && x.id === uid);
    return u ? latestLeaderboard.indexOf(u) + 1 : 0;
  }
  /* 该 uid 是否在关注范围：关注列表（手动/反推） ∪ Top 榜前 watchTopN；主动移除（屏蔽）者除外 */
  function isWatched(uid) {
    if (!uid) return false;
    if (window.__fomoUser && window.__fomoUser.isWatchBlocked && window.__fomoUser.isWatchBlocked(uid)) return false;
    if (window.__fomoUser && window.__fomoUser.watchHas && window.__fomoUser.watchHas(uid)) return true;
    const rank = rankOfUser(uid);
    return rank > 0 && rank <= watchTopN;
  }
  /* 交易动态条目是否命中关注范围（支持 collective 多用户） */
  function isWatchedFeed(f, body) {
    const uid = (f && f.userId) || body.userId || (f && f.user && f.user.id);
    if (uid && isWatched(uid)) return true;
    if (Array.isArray(body.users) && body.users.length) {
      return body.users.some((u) => isWatched(u && (u.id || u.userId)));
    }
    return false;
  }
  /* uid 是否已有真实钱包地址（预置库 / 反推收录） */
  function hasRealAddrOf(uid) {
    const cu = uid ? findLibUser({ id: uid }) : null;
    return !!(cu && (cu._evmReal || cu._solReal));
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
    if (/thesis|manual/.test(type)) return { label: "💡 观点", cls: "new" };
    if (type.includes("buy")) return { label: "买入", cls: "buy" };
    if (type.includes("sell") || type.includes("close")) return { label: "卖出", cls: "sell" };
    return { label: signLabel(s.type), cls: "new" };
  }

  /* feed 观点条目（thesis_created / manual）→ 信号行对象，供 renderSignals 复用同一行模板 */
  function thesisToSignal(f) {
    if (!f) return null;
    const b = f.body || {};
    const t = String(f.feedType || b.feedType || f.type || "").toLowerCase();
    if (!/thesis|manual/.test(t)) return null;
    const uid = f.userId || b.userId || (f.user && f.user.id);
    const text = String(b.text || b.message || b.comment || b.entryMessage || "");
    const tok = b.token || {};
    const tokenAddr = b.tokenAddress || f.tokenAddress || tok.address || "";
    return {
      _isThesis: true,
      id: f.id || f.feedItemId || "",
      type: "thesis_created",
      userId: uid,
      displayName: f.displayName || (f.user && f.user.displayName) || b.displayName || "",
      userHandle: f.userHandle || (f.user && f.user.userHandle) || b.userHandle || "",
      profilePictureLink: f.profilePictureLink || (f.user && f.user.profilePictureLink) || "",
      followers: Number(f.followers) || (f.user && Number(f.user.followers)) || Number(b.followers) || 0,
      networkId: b.networkId || f.networkId || tok.networkId,
      tokenAddress: tokenAddr,
      token: {
        address: tokenAddr,
        symbol: b.tokenSymbol || f.ticker || tok.symbol || tok.name || "",
        name: b.tokenName || tok.name || "",
        imageUrl: tok.imageUrl || (tok.info && (tok.info.imageThumbUrl || tok.info.imageSmallUrl)) || "",
        networkId: b.networkId || f.networkId || tok.networkId,
      },
      comment: text ? { comment: text } : null,
      body: b,
      createdAt: f.createdAt,
      usdAmount: null,
      price: null,
    };
  }

  /* tradingActivity 买入条目（swap_buy，单笔 ≥$200）→ 交易动态(feed)条目，
   * 让"任何代币单笔 ≥$200 的买入"也出现在【交易动态】tab（feed 接口本身不含 swap_buy） */
  function taToFeed(s) {
    if (!s) return null;
    const b = s.body && typeof s.body === "object" ? s.body : {};
    const usd = Number(s.usdAmount || b.amountInUsd || 0);
    if (!(usd >= pushMinUsdThreshold)) return null;
    const tt = (Array.isArray(b.topTraders) && b.topTraders[0]) || {};
    const uid = s.userId || tt.id;
    const type = String(s.type || s.feedType || b.feedType || "swap_buy").toLowerCase();
    if (!/buy/.test(type)) return null;
    const tok = b.token || {};
    const tokenAddr = s.tokenAddress || b.tokenAddress || tok.address || "";
    return {
      _fromTa: true,
      feedType: "swap_buy",
      type: "swap_buy",
      userId: uid,
      displayName: s.displayName || tt.displayName || "",
      userHandle: s.userHandle || tt.userHandle || "",
      profilePictureLink: s.profilePictureLink || tt.userImageUrl || "",
      createdAt: s.createdAt,
      body: {
        tokenSymbol: s.ticker || b.tokenSymbol || tok.symbol || "",
        tokenAddress: tokenAddr,
        networkId: s.networkId || b.networkId || tok.networkId,
        amountInUsd: usd,
        price: s.price != null ? s.price : b.price,
        message: `单笔买入 ${fmtUsd(usd)}${s.ticker ? " · " + s.ticker : ""}`,
      },
    };
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

    // 观点条目（thesis/manual）转换为信号行，合并到列表最前面
    const thesisRows = (latestThesis || [])
      .map(thesisToSignal)
      .filter(Boolean);
    const all = [...thesisRows, ...(list || [])];

    // 过滤逻辑: all / top / top_buy / watch（观点行无排行榜名次 → 自动被 top 过滤排除）
    const rows = all.filter((s) => {
      const tt = (s.body && Array.isArray(s.body.topTraders) && s.body.topTraders[0]) || {};
      const u = usersById.get(s.userId || tt.id);
      const rank = u ? latestLeaderboard.indexOf(u) + 1 : 0;
      const isTop = Boolean(rank && rank <= topSignalThreshold);
      const action = signalAction(s);

      if (currentSigFilter === "watch") return isWatched(s.userId || tt.id);
      if (currentSigFilter === "top") return isTop;
      if (currentSigFilter === "top_buy") return isTop && action.cls === "buy";
      return true; // "all"
    });

    // 用户要求：任何代币单笔 ≥$200 的买入必须展示在跟单信号里 → 置顶
    // 观点行保持在最前，其余按 金额规则 优先（Array.sort 稳定，同组内保持原顺序）
    const thesisPart = rows.filter((s) => s._isThesis);
    const tradePart = rows
      .filter((s) => !s._isThesis)
      .sort(
        (a, b) =>
          (Number(b.usdAmount || 0) >= pushMinUsdThreshold ? 1 : 0) -
          (Number(a.usdAmount || 0) >= pushMinUsdThreshold ? 1 : 0)
      );
    rows.splice(0, rows.length, ...thesisPart, ...tradePart);

    const topBuyCount = (all || []).filter((s) => {
      const tt = (s.body && Array.isArray(s.body.topTraders) && s.body.topTraders[0]) || {};
      const u = usersById.get(s.userId || tt.id);
      const rank = u ? latestLeaderboard.indexOf(u) + 1 : 0;
      return rank && rank <= topSignalThreshold && signalAction(s).cls === "buy";
    }).length;

    const countBadge = $("#sigCountBadge");
    if (countBadge) countBadge.textContent = `${rows.length} 条`;

    const meta = $("#sigMeta");
    if (meta) meta.textContent = `近 500 条信号 · Top ${topSignalThreshold} 榜单买入 ${topBuyCount} 条 · 观点 ${thesisRows.length} 条（已合并推送提醒）`;

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="6" class="empty">${currentSigFilter === "all" ? "暂无跟单信号" : "暂无符合条件的 Top 50 信号"}</td></tr>`;
      return;
    }

    const jobs = []; // 异步翻译任务
    rows.slice(0, 200).forEach((s, i) => {
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
              <div class="name">${esc(sigUser.displayName || sigUser.userHandle || "匿名天团")} ${libBadge(findLibUser(sigUser))}${rank ? `<span class="rank-badge" title="排行榜第 ${rank} 名">#${rank}</span>` : ""}${s._isThesis && s.followers ? `<span class="rank-badge" title="推特粉丝 ${s.followers}">👥 ${fmtNum(s.followers)}</span>` : ""}</div>
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
        <td>${s._isThesis ? '<span class="muted">💡 观点帖</span>' : holdingsSummary(leaderboardUser, s)}</td>
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

    // 过滤逻辑: all / watch / collective / new_token / thesis / milestone
    const filtered = feedList.filter((f) => {
      const body = typeof f.body === "object" && f.body ? f.body : {};
      const rawType = String(f.feedType || body.feedType || f.type || "").toLowerCase();

      if (currentFeedFilter === "watch") {
        return isWatchedFeed(f, body);
      }
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

    filtered.slice(0, 200).forEach((f, i) => {
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

  /* ---------- 关注列表（Watchlist）渲染与交互 ---------- */
  function watchSourceLabel(w) {
    if (w.source === "reveal") return '<span class="watch-src watch-src-real">🔍 真实地址</span>';
    if (w.source === "top") return `<span class="watch-src watch-src-top">🏆 Top ${w.rank || "?"}</span>`;
    return '<span class="watch-src watch-src-manual">📌 手动添加</span>';
  }

  function renderWatchlist() {
    const body = $("#watchBody");
    if (!body) return;
    body.innerHTML = "";
    const persisted = (window.__fomoUser && window.__fomoUser.watchItems) ? window.__fomoUser.watchItems() : [];
    const persistedUids = new Set(persisted.map((w) => w.uid));
    // 动态并入 Top 榜前 watchTopN（不持久化）
    const topRows = latestLeaderboard.slice(0, watchTopN).map((u, i) => ({
      uid: u.id,
      displayName: u.displayName, userHandle: u.userHandle,
      avatar: u.profilePictureLink, source: "top", addedAt: 0, rank: i + 1,
    }));
    const all = [
      ...persisted
        .map((w) => ({ ...w, rank: rankOfUser(w.uid) }))
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)),
      // Top 榜动态并入（主动移除/屏蔽的除外，即使回到前 N 也不并入）
      ...topRows.filter((t) => !persistedUids.has(t.uid) && !(window.__fomoUser && window.__fomoUser.isWatchBlocked && window.__fomoUser.isWatchBlocked(t.uid))),
    ];
    let rows = all;
    if (currentWatchFilter === "real") rows = all.filter((w) => hasRealAddrOf(w.uid));
    else if (currentWatchFilter === "top") rows = all.filter((w) => w.source === "top");
    else if (currentWatchFilter === "manual") rows = all.filter((w) => w.source !== "top");

    const badge = $("#watchCountBadge");
    if (badge) badge.textContent = `${rows.length} 人`;

    if (!rows.length) {
      body.innerHTML = `<div class="empty">${currentWatchFilter === "all" ? "关注列表为空：反推命中真实地址的用户会自动收录，Top 榜前 30 名自动并入，也可在上方手动添加。已移除的用户不会重新出现" : "该分类下暂无关注用户"}</div>`;
      return;
    }
    rows.slice(0, 300).forEach((w) => {
      const cu = findLibUser({ id: w.uid });
      const realBadge = hasRealAddrOf(w.uid)
        ? '<span class="fp-badge fp-real" title="有真实钱包">✅真实钱包</span>'
        : cu ? '<span class="fp-badge fp-fake" title="仅平台展示地址">⚠️展示</span>' : "";
      const avatar = w.avatar
        ? `<img class="avatar" src="${esc(w.avatar)}">`
        : `<div class="avatar"></div>`;
      const item = document.createElement("div");
      item.className = "watch-item" + (w.source === "top" ? " watch-top" : "");
      item.innerHTML = `
        <div class="trader clickable-user" data-uid="${esc(w.uid)}" title="点击查看用户详情">
          ${avatar}
          <div>
            <div class="name">${esc(w.displayName || w.userHandle || "匿名")} ${realBadge}</div>
            <div class="handle">@${esc(w.userHandle || "")} ${watchSourceLabel(w)}</div>
          </div>
        </div>
        ${`<button class="btn watch-remove" data-watch-remove="${esc(w.uid)}" title="移除关注（${w.source === "top" ? "Top 榜用户移除后不再自动并入" : "从关注列表中移除"}）">✕</button>`}`;
      body.appendChild(item);
    });
  }

  /* 把输入解析为可关注的用户（用户名 / ID / 钱包地址） */
  async function resolveWatchUser(q) {
    const s = String(q || "").trim();
    if (!s) return null;
    const norm = s.toLowerCase();
    // 1) 钱包地址 → 地址索引反查 uid
    if (norm.startsWith("0x") || norm.length >= 40 || /^sol/i.test(norm)) {
      const entry = window.__addrIndex && window.__addrIndex.get(norm);
      if (entry && entry.uid) return { uid: entry.uid, displayName: entry.displayName, userHandle: entry.userHandle, avatar: "", via: "addr" };
      try {
        const d = await api("/v2/users/fuzzy-search?searchTerm=" + encodeURIComponent(s.replace(/^@/, "")));
        const us = (d && d.responseObject && d.responseObject.users) || [];
        if (us.length) { const u = us[0]; return { uid: u.id, displayName: u.displayName, userHandle: u.userHandle, avatar: u.profilePictureLink, via: "fuzzy" }; }
      } catch (_e) {}
      return null;
    }
    // 2) 排行榜精确匹配 handle / id / displayName
    const ql = s.replace(/^@/, "").toLowerCase();
    let m = latestLeaderboard.find((u) => (u.userHandle || "").toLowerCase() === ql || (u.id || "").toLowerCase() === ql);
    if (!m) m = latestLeaderboard.find((u) => (u.displayName || "").toLowerCase() === ql);
    if (m) return { uid: m.id, displayName: m.displayName, userHandle: m.userHandle, avatar: m.profilePictureLink, via: "lb" };
    // 3) 用户缓存匹配（反推收录过的用户）
    if (window.__userCache && window.__userCache.get) {
      const hit = window.__userCache.get(ql) || window.__userCache.get("h:" + ql);
      if (hit && hit.id) return { uid: hit.id, displayName: hit.displayName, userHandle: hit.userHandle, avatar: hit.profilePictureLink || "", via: "cache" };
    }
    // 4) 兜底 fuzzy-search
    try {
      const d = await api("/v2/users/fuzzy-search?searchTerm=" + encodeURIComponent(ql));
      const us = (d && d.responseObject && d.responseObject.users) || [];
      if (us.length) { const u = us[0]; return { uid: u.id, displayName: u.displayName, userHandle: u.userHandle, avatar: u.profilePictureLink, via: "fuzzy" }; }
    } catch (_e) {}
    return null;
  }

  async function addWatchFromInput() {
    const input = $("#watchAddInput");
    if (!input) return;
    const q = input.value.trim();
    if (!q || !window.__fomoUser || !window.__fomoUser.watchAdd) return;
    const r = await resolveWatchUser(q);
    if (!r || !r.uid) {
      input.placeholder = "未找到该用户，请检查用户名 / ID / 地址";
      input.classList.add("err");
      setTimeout(() => { input.classList.remove("err"); }, 1500);
      return;
    }
    await window.__fomoUser.watchAdd(r.uid, { displayName: r.displayName, userHandle: r.userHandle, avatar: r.avatar }, "manual");
    input.value = "";
    input.placeholder = "粘贴 FOMO 用户名 / 用户ID / 钱包地址，回车添加";
    renderWatchlist();
    renderSignals(latestSignals);
    renderFeed(latestFeed);
  }

  async function removeWatch(uid) {
    if (!uid || !window.__fomoUser || !window.__fomoUser.watchRemove) return;
    await window.__fomoUser.watchRemove(uid);
    renderWatchlist();
    renderSignals(latestSignals);
    renderFeed(latestFeed);
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
      // 关注列表：同步持久化数据 + 渲染（Top 榜前 N 动态并入）
      if (window.__fomoUser && window.__fomoUser.loadWatchlist) await window.__fomoUser.loadWatchlist();
      renderWatchlist();
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
        // 合并 tradingActivity 中"单笔 ≥$200 的买入"进交易动态（feed 接口本身不含 swap_buy）
        const bigBuyRows = (sigList || []).map(taToFeed).filter(Boolean);
        latestFeed = [...bigBuyRows, ...latestFeed];
        renderFeed(latestFeed);
      } catch (_) {
        latestFeed = [];
        renderFeed(null);
      }
      // 观点条目（thesis/manual）→ 合并进跟单信号列表（走后台 30s 缓存，不额外打接口）
      try {
        const tr = await chrome.runtime.sendMessage({ action: "getThesisFeed" });
        latestThesis = (tr && tr.ok && Array.isArray(tr.items)) ? tr.items : [];
      } catch (_e) {
        latestThesis = [];
      }
      renderSignals(latestSignals);
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

  /* ---------- 关注列表交互 ---------- */
  document.querySelectorAll("[data-watch-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-watch-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentWatchFilter = btn.dataset.watchFilter || "all";
      renderWatchlist();
    });
  });
  const watchAddBtn = $("#watchAddBtn");
  if (watchAddBtn) watchAddBtn.addEventListener("click", addWatchFromInput);
  const watchAddInput = $("#watchAddInput");
  if (watchAddInput) watchAddInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addWatchFromInput(); });
  const watchBody = $("#watchBody");
  if (watchBody) watchBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-watch-remove]");
    if (btn) {
      e.stopPropagation();
      removeWatch(btn.getAttribute("data-watch-remove"));
    }
  });

  /* ---------- 控制 ---------- */
  $("#refreshBtn").addEventListener("click", () => {
    refreshSessionUI();
    loadAll();
  });
  $("#exportWalletsBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const old = btn.textContent;
    try {
      const n = await exportRealWallets();
      btn.textContent = `✓ ${n} 个地址`;
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch (_e) {
      btn.textContent = "✗ 导出失败";
      setTimeout(() => { btn.textContent = old; }, 1800);
    }
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
  const pushMinUsd = $("#pushMinUsd");
  const pushThesisToggle = $("#pushThesisToggle");
  chrome.storage.local.get(["pushEnabled", "pushTopN", "pushMinUsd", "pushThesis"]).then((c) => {
    if (pushToggle) pushToggle.checked = c.pushEnabled !== false;
    topSignalThreshold = c.pushTopN || 30;
    if (pushTopN) pushTopN.value = topSignalThreshold;
    if (pushMinUsd) {
      pushMinUsd.value = c.pushMinUsd != null ? c.pushMinUsd : 200;
      pushMinUsdThreshold = Number(pushMinUsd.value) || 200;
    }
    if (pushThesisToggle) pushThesisToggle.checked = c.pushThesis !== false;
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
  if (pushMinUsd) {
    pushMinUsd.addEventListener("change", () => {
      const v = Math.max(1, Number(pushMinUsd.value) || 200);
      pushMinUsd.value = v;
      pushMinUsdThreshold = v;
      chrome.storage.local.set({ pushMinUsd: v });
    });
  }
  if (pushThesisToggle) {
    pushThesisToggle.addEventListener("change", () => {
      chrome.storage.local.set({ pushThesis: pushThesisToggle.checked });
    });
  }
  /* ---------- 推送 Toast（右下角弹出；hover 停留；点击搜索代币） ---------- */
  const TOAST_MS = 10000; // 自动消失时长
  const TOAST_MAX = 5;    // 同时最多显示 5 个
  const dismissToast = (el) => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  };
  const showPushToast = ({ title, line, token }) => {
    const host = document.getElementById("toastHost");
    if (!host) return;
    // 同一代币的重复推送 → 只保留最新一条（避免刷屏）
    const key = token || ("t:" + title);
    const prev = Array.from(host.children).find((el) => el.dataset.key === key);
    if (prev) prev.remove();
    const el = document.createElement("div");
    el.className = "push-toast" + (token ? " clickable" : "");
    el.dataset.key = key;
    el.innerHTML =
      `<div class="pt-title">${title}</div>` +
      `<div class="pt-line">${line || ""}</div>` +
      (token ? `<div class="pt-hint">👆 点击搜索代币</div>` : "") +
      `<span class="pt-close" title="关闭">×</span>`;
    host.appendChild(el);
    while (host.children.length > TOAST_MAX) host.firstElementChild.remove();
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
    const dismiss = () => dismissToast(el);
    let timer = setTimeout(dismiss, TOAST_MS);
    // hover 停留：悬停时暂停自动消失，移开重新计时
    el.addEventListener("mouseenter", () => { clearTimeout(timer); el.classList.add("hover"); });
    el.addEventListener("mouseleave", () => { el.classList.remove("hover"); timer = setTimeout(dismiss, TOAST_MS); });
    el.addEventListener("click", (ev) => {
      if (ev.target.closest(".pt-close")) { clearTimeout(timer); dismiss(); return; }
      if (token && window.__fomoSearch && window.__fomoSearch.run) {
        clearTimeout(timer);
        dismiss();
        window.__fomoSearch.run(token); // 点击 toast → 搜索该代币
        const sr = document.getElementById("searchResult");
        if (sr) sr.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  };
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "topBuyPush") {
      const s = msg.sig || {};
      const ticker = s.ticker || (s.token && s.token.symbol) || "";
      const token = s.tokenAddress || (s.token && s.token.address) || "";
      showPushToast({
        title: `${esc(s.displayName || s.userHandle || "")} 买入 ${esc(ticker)}${msg.rank ? " #" + msg.rank : ""}`,
        line: `${msg.byAmount && s.usdAmount ? "金额 $" + esc(s.usdAmount) + " · " : ""}${timeAgo(s.createdAt)}`,
        token,
      });
    }
    if (msg && msg.action === "thesisPush") {
      const it = msg.item || {};
      const b = it.body || {};
      const text = (b.text || b.message || b.comment || "").toString().slice(0, 60);
      const tokenName = b.tokenSymbol || b.tokenName || it.ticker ||
        (b.token && (b.token.symbol || b.token.name)) || "";
      const token = b.tokenAddress || (b.token && b.token.address) || it.tokenAddress || "";
      showPushToast({
        title: `📣 ${esc(it.displayName || it.userHandle || "")} 发布观点${tokenName ? " · " + esc(tokenName) : ""}`,
        line: `粉丝 ${esc(msg.followers || "")}${text ? "：" + esc(text) : ""} · ${timeAgo(it.createdAt)}`,
        token,
      });
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
