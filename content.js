/* content.js — 在 GMGN / DeBot 页面上给 FOMO 已知地址打标签
 * 库: window.__FOMO_DB (address_db.js, 与 content.js 同集合加载,共享隔离 world)
 * 真实钱包 → 绿标 "FOMO·handle"; 展示假地址 → 红标 "⚠handle·展示"
 * 只读,不改页面数据,仅插入标签元素。    
 */
(() => {
  "use strict";
  // 诊断标记: 主世界可查(判定 content script 是否注入)
  try { document.documentElement.setAttribute("data-fomo-ftag", "loaded"); } catch (_e) {}
  const stat = { scanned: 0, tagged: 0, lib: 0, mine: 0 };
  const DB = window.__FOMO_DB;
  if (!DB || !Array.isArray(DB.users)) {
    try { document.documentElement.setAttribute("data-fomo-stat", "DB_MISSING"); } catch (_e) {}
    return;   // 库缺失则不注入
  }
  stat.lib = DB.users.length;

  const userById = {};
  for (const u of DB.users) userById[u.id] = u;

  const RE_EVM = /\b0x[a-fA-F0-9]{40}\b/g;
  const RE_SOL = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;

  // 本地收录库(用户在扩展里存的自定义标签, 最高优先级)
  let myLib = [];
  try {
    chrome.storage.local.get("fomoMyLib").then((s) => {
      if (Array.isArray(s.fomoMyLib)) myLib = s.fomoMyLib;
    }).catch(() => {});
  } catch (_e) {}

  // 反查自动收录的真实地址(fomoLookupHits, 与预置库同等"真实钱包"待遇)
  let lookupByAddr = {};
  try {
    chrome.storage.local.get("fomoLookupHits").then((s) => {
      const map = s.fomoLookupHits || {};
      for (const h of Object.values(map)) {
        if (h && h.evm) lookupByAddr[String(h.evm).toLowerCase()] = { kind: "real_evm", handle: h.handle, displayName: h.displayName };
        if (h && h.sol) lookupByAddr[String(h.sol).toLowerCase()] = { kind: "real_sol", handle: h.handle, displayName: h.displayName };
      }
    }).catch(() => {});
  } catch (_e) {}

  // 地址 → 标签(本地收录 > 反查收录 > 预置库; 都不在的一律不标, 避免噪声)
  function labelFor(addr) {
    const key = addr.toLowerCase();
    const mine = myLib.find((x) => String(x.addr).toLowerCase() === key);
    if (mine) {
      stat.mine++;
      return { cls: "ftag-mine", text: "📌 " + (mine.label || "已收录"), title: mine.note || "本地收录地址" };
    }
    const lh = lookupByAddr[key];
    if (lh) {
      stat.tagged++;
      const name = lh.handle || lh.displayName || "FOMO用户";
      return {
        cls: "ftag-real",
        text: "FOMO·" + name,
        title: "反查收录真实钱包(" + (lh.kind === "real_evm" ? "EVM" : "Solana") + "), 用户: " + name,
      };
    }
    const m = DB.addrMap[key];
    if (!m) return null;
    const u = userById[m.uid] || {};
    const name = u.handle || u.displayName || "FOMO用户";
    const isReal = m.kind === "real_evm" || m.kind === "real_sol";
    stat.tagged++;
    return {
      cls: isReal ? "ftag-real" : "ftag-fake",
      text: isReal ? "FOMO·" + name : "⚠" + name + "·展示",
      title: (isReal ? "FOMO 真实钱包(" : "FOMO 展示假地址(") + m.kind + "), 用户: " + name,
    };
  }

  // 扫描文本节点:匹配地址 → 在其后插入标签
  function scanTextNode(node) {
    const txt = node.nodeValue;
    if (!txt || txt.length < 40) return;
    // 只扫描含潜在地址的文本,避免每个文本节点都正则两次
    if (!/0x[a-fA-F0-9]{40}/.test(txt) && !/[1-9A-HJ-NP-Za-km-z]{43}/.test(txt)) return;
    const parent = node.parentElement;
    if (!parent || parent.closest(".ftag-wrap")) return;  // 已处理过的不再处理

    const hits = [];
    let m;
    RE_EVM.lastIndex = 0;
    while ((m = RE_EVM.exec(txt))) {
      const lbl = labelFor(m[0]);
      if (lbl) hits.push({ start: m.index, end: m.index + m[0].length, lbl });
    }
    RE_SOL.lastIndex = 0;
    while ((m = RE_SOL.exec(txt))) {
      const lbl = labelFor(m[0]);
      if (lbl) hits.push({ start: m.index, end: m.index + m[0].length, lbl });
    }
    if (!hits.length) return;
    hits.sort((a, b) => a.start - b.start);
    // 合并重叠(同一地址多次匹配)
    const merged = [hits[0]];
    for (let i = 1; i < hits.length; i++) {
      const last = merged[merged.length - 1];
      if (hits[i].start < last.end) continue;
      merged.push(hits[i]);
    }

    const frag = document.createDocumentFragment();
    const wrap = document.createElement("span");
    wrap.className = "ftag-wrap";
    let last = 0;
    for (const h of merged) {
      wrap.appendChild(document.createTextNode(txt.slice(last, h.start)));
      wrap.appendChild(document.createTextNode(txt.slice(h.start, h.end)));
      const tag = document.createElement("span");
      tag.className = "ftag " + h.lbl.cls;
      tag.textContent = h.lbl.text;
      tag.title = h.lbl.title;
      wrap.appendChild(tag);
      last = h.end;
    }
    wrap.appendChild(document.createTextNode(txt.slice(last)));
    parent.replaceChild(wrap, node);
  }

  // 扫描元素的所有属性和 href 里的完整地址
  // GMGN/DeBot 持有者列表地址常缩略显示, 完整地址藏在 title/href/data-* 属性里
  function scanAttrs(el) {
    if (el.__ftagAttrDone) return;
    el.__ftagAttrDone = true;
    if (el.querySelector(".ftag")) return;   // 已有标签
    const matches = [];
    if (el.attributes) {
      for (const attr of el.attributes) {
        const v = attr.value;
        if (!v || v.length < 40) continue;
        let m;
        RE_EVM.lastIndex = 0;
        while ((m = RE_EVM.exec(v))) matches.push({ addr: m[0], lbl: labelFor(m[0]) });
        RE_SOL.lastIndex = 0;
        while ((m = RE_SOL.exec(v))) matches.push({ addr: m[0], lbl: labelFor(m[0]) });
      }
    }
    // href 里的地址(站内/区块浏览器链接)
    const href = el.getAttribute && el.getAttribute("href");
    if (href && href.length > 40) {
      let m;
      RE_EVM.lastIndex = 0;
      while ((m = RE_EVM.exec(href))) matches.push({ addr: m[0], lbl: labelFor(m[0]) });
      RE_SOL.lastIndex = 0;
      while ((m = RE_SOL.exec(href))) matches.push({ addr: m[0], lbl: labelFor(m[0]) });
    }
    const hit = matches.filter((x) => x.lbl);
    if (!hit.length) return;
    // 插入标签: 插到元素自身尾部(若可见)或父级, 并带 data 供后续去重
    for (const h of hit) {
      const tag = document.createElement("span");
      tag.className = "ftag " + h.lbl.cls;
      tag.textContent = h.lbl.text;
      tag.title = h.lbl.title + " (" + h.addr + ")";
      el.appendChild(tag);
    }
    // 若元素不可见(隐藏容器), 尝试在父级尾部再插一个(提升可见性)
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (rect && (rect.width === 0 || rect.height === 0) && el.parentElement && !el.parentElement.querySelector(".ftag")) {
      const tag2 = document.createElement("span");
      tag2.className = "ftag " + hit[0].lbl.cls;
      tag2.textContent = hit[0].lbl.text;
      tag2.title = hit[0].lbl.title;
      el.parentElement.appendChild(tag2);
    }
  }

  // 批量扫描(节流)
  let pending = [];
  let timer = null;
  function flush() {
    timer = null;
    const nodes = pending;
    pending = [];
    for (const n of nodes) {
      try {
        if (n.nodeType === 3) { stat.scanned++; scanTextNode(n); }
        else if (n.nodeType === 1) { stat.scanned++; scanAttrs(n); }
      } catch (_e) { /* 单节点失败不影响后续 */ }
    }
    try { document.documentElement.setAttribute("data-fomo-stat", JSON.stringify(stat)); } catch (_e) {}
  }
  function queue(node) {
    pending.push(node);
    if (pending.length > 200) flush();   // 积压过多立即处理
    if (!timer) timer = setTimeout(flush, 250);
  }

  // 初始扫描: 文本 + 元素属性
  const all = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = all.nextNode())) queue(n);

  // 动态内容监听(SPA 页面持续插入节点)
  const mo = new MutationObserver((muts) => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (!node) continue;
        if (node.nodeType === 1) {
          queue(node);
          const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let t;
          while ((t = w.nextNode())) queue(t);
        } else if (node.nodeType === 3) {
          queue(node);
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();
