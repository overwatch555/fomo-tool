/* lookup.js — 反查协调器与全局控制
 * 统一调度 EVM (Base/BSC/Robinhood) 与 Solana 反查，管理进度与结果整合
 *
 * 反查流程：
 *  1) 拉取 /v2/users/{id}/swaps（每条记录带 createdAt/代币地址/金额，address 为 fomo 占位地址）
 *  2) 直出候选：/trades 明细的 swap.address + swaps[].address，全部过 7702 指纹核验
 *     （真实钱包才有 ef0100 委托代码；占位壳链上无代码，指纹一验即淘汰）
 *  3) 多链时间戳对撞：对每个有交易的 EVM 链跑 collision 引擎，取置信度最高的结果
 *  4) Solana 跨链印证（relay.link）
 */
(() => {
  "use strict";

  async function api(path, options) {
    const r = await chrome.runtime.sendMessage({ action: "call", path, options });
    if (!r || !r.ok) throw new Error(r ? r.error : "background 无响应");
    if (!r.r.ok) throw new Error("HTTP " + r.r.status);
    return r.r.data;
  }

  /* ============ 数据源 1：/trades + /trades/{id} 明细的执行地址 ============ */
  async function collectDirectSwaps(userId) {
    const out = [];
    try {
      const data = await api("/trades?userId=" + encodeURIComponent(userId) + "&limit=25");
      const ro = data.responseObject || data || {};
      let trades = [];
      if (Array.isArray(ro)) trades = ro;
      else if (ro.items && Array.isArray(ro.items)) trades = ro.items.map((it) => (it && it.trade ? it.trade : it));
      else if (ro.activeTrades || ro.closedTrades) trades = [...(ro.activeTrades || []), ...(ro.closedTrades || [])].map((it) => (it && it.trade ? it.trade : it));
      console.log("[lookup] trades count:", trades.length);
      for (const t of trades.slice(0, 10)) {
        if (!t || !t.id) continue;
        try {
          const d = await api("/trades/" + encodeURIComponent(t.id));
          const det = d.responseObject || d || {};
          (det.swaps || []).forEach((s) => {
            if (s && s.address && /^0x/i.test(s.address)) {
              out.push({ address: s.address, chainId: Number(s.networkId || s.inNetworkId || t.networkId) || 8453 });
            }
          });
        } catch (_e) {}
      }
      console.log("[lookup] direct swaps collected:", out.length, out.slice(0, 3));
    } catch (e) {
      console.warn("[lookup] collectDirectSwaps failed:", e.message);
    }
    return out;
  }

  /* ============ /v2/users/{id}/swaps 归一化 ============ */
  function pick(obj, keys, wantAddr) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const k of keys) {
      let v = obj[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "object") {
        if (wantAddr && (v.address || v.tokenAddress)) v = v.address || v.tokenAddress;
        else continue;
      }
      if (wantAddr && typeof v === "string") {
        const m = v.match(/0x[a-fA-F0-9]{40}/);
        if (m) v = m[0];
      }
      return v;
    }
    return undefined;
  }

  function normSwap(s) {
    if (!s || typeof s !== "object") return null;
    return {
      createdAt: pick(s, ["createdAt", "timestamp", "time", "date", "blockTimestamp", "created_at"]),
      inTokenAddress: pick(s, ["inTokenAddress", "fromTokenAddress", "tokenInAddress", "inToken", "inputTokenAddress", "tokenIn"], true),
      outTokenAddress: pick(s, ["outTokenAddress", "toTokenAddress", "tokenOutAddress", "outToken", "outputTokenAddress", "tokenOut"], true),
      inHumanAmount: pick(s, ["inHumanAmount", "humanAmountIn", "amountIn", "inAmount"]),
      outHumanAmount: pick(s, ["outHumanAmount", "humanAmountOut", "amountOut", "outAmount"]),
      networkId: pick(s, ["networkId", "chainId", "inNetworkId", "network"]),
      address: pick(s, ["address"]),
      provider: pick(s, ["provider"]),
    };
  }

  /* 对一组地址做 7702 指纹核验，返回通过者（去重） */
  async function verifyByFingerprint(candidates) {
    const verified = [];
    const seen = new Set();
    for (const d of candidates) {
      if (!d || !d.address) continue;
      const key = d.chainId + ":" + d.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const isFomo = await window.__rpc.isFomoDelegated(d.chainId, d.address);
        console.log("[lookup] fingerprint", d.chainId, d.address, "=>", isFomo);
        if (isFomo) verified.push(d);
      } catch (_e) {}
    }
    return verified;
  }

  /* ============ 主入口 ============ */
  async function startLookup(userId, onProgress) {
    const report = (phase, detail, chainId = null, progressPct = 0) => {
      if (onProgress) onProgress({ phase, detail, chainId, progressPct });
    };

    report("fetching_swaps", "正在从 FOMO API 获取用户 Swap 交易记录...", null, 5);

    /* ---- 拉取主数据源：swaps ---- */
    let swaps = [];
    try {
      const data = await api(`/v2/users/${encodeURIComponent(userId)}/swaps`);
      console.log("[lookup] /v2/users/{id}/swaps RAW:", JSON.stringify(data).slice(0, 3000));
      const ro = data.responseObject || data || {};
      swaps = Array.isArray(ro) ? ro : (ro.swaps || ro.items || ro.list || []);
    } catch (e) {
      console.warn("[lookup] swaps endpoint error:", e.message);
    }
    swaps = swaps.map(normSwap).filter(Boolean);
    console.log("[lookup] normalized swaps:", swaps.length, swaps[0] && JSON.stringify(swaps[0]).slice(0, 600));

    /* ---- 路径 1：直出候选（trades 明细 + swaps[].address）→ 7702 指纹核验 ---- */
    report("collecting_direct", "正在收集执行地址并做 7702 指纹核验...", null, 10);
    const directPool = await collectDirectSwaps(userId);
    // swaps[].address 也可能是真实执行地址（fingerprint 会淘汰占位壳）
    for (const s of swaps) {
      if (s && s.address && /^0x/i.test(s.address)) {
        directPool.push({ address: s.address, chainId: Number(s.networkId) || 8453 });
      }
    }
    const verified = await verifyByFingerprint(directPool);
    if (verified.length) {
      console.log("[lookup] verified direct addresses:", verified);
      report("done", `已直接命中 ${verified.length} 个真实链上地址（7702 指纹核验通过）`, verified[0].chainId, 100);
      const first = verified[0];
      return {
        userId,
        hasSwaps: true,
        mainEvmChain: first.chainId,
        direct: verified,
        evm: {
          address: first.address,
          confidence: "iron",
          source: "fingerprint_direct",
          hitWindows: verified.length,
          totalWindows: verified.length,
          hitRate: "100%",
          amountMatches: verified.length,
          stats: { total: directPool.length, scanned: 0, candidates: verified.length },
        },
        sol: null,
      };
    }

    if (!swaps.length) {
      report("done", "未找到可用的 Swap 记录（swaps 接口无数据，且无可核验的执行地址）", null, 100);
      return {
        userId,
        hasSwaps: false,
        direct: null,
        evm: null,
        sol: null,
        summary: "未找到任何可用的交易记录",
      };
    }

    /* ---- 路径 2：多链时间戳对撞 ---- */
    report("parsing_chains", `已获取到 ${swaps.length} 笔 Swap 记录，正在按区块链分组...`, null, 15);

    const swapsByChain = {};
    for (const s of swaps) {
      const nid = Number(s.networkId) || 8453;
      swapsByChain[nid] = swapsByChain[nid] || [];
      swapsByChain[nid].push(s);
    }

    const evmChainPriority = [8453, 56, 4663, 1];
    const evmResults = {};
    let totalEvmSwaps = 0;
    for (const cid of evmChainPriority) {
      const chainSwaps = swapsByChain[cid] || [];
      if (!chainSwaps.length) continue;
      totalEvmSwaps += chainSwaps.length;
      report("evm_lookup", `开始对 Chain ${cid} (${chainName(cid)}) 的 ${chainSwaps.length} 笔交易做时间戳对撞...`, cid, 30);

      const result = await window.__lookupEvm.evmLookup(chainSwaps, cid, (p) => {
        let pct = 30;
        if (p.phase === "estimating_blocks") pct = 35;
        if (p.phase === "scanning_logs") pct = 50;
        if (p.phase === "fingerprinting") pct = 70;
        if (p.phase === "cross_validating") pct = 85;
        if (p.phase === "amount_verifying") pct = 90;
        report(p.phase, p.detail, cid, pct);
      });
      evmResults[cid] = result;

      // 命中强结果即提前结束（避免跨链重复扫描）
      if (result && result.address && (result.confidence === "iron" || result.confidence === "strong")) break;
    }

    // 取各链中置信度最高的结果
    const confRank = { iron: 4, strong: 3, moderate: 2, weak: 1, none: 0 };
    let evmResult = null;
    let mainEvmChain = null;
    for (const cid of evmChainPriority) {
      const r = evmResults[cid];
      if (!r || !r.address) continue;
      if (!evmResult || (confRank[r.confidence] || 0) > (confRank[evmResult.confidence] || 0)
        || (r.confidence === evmResult.confidence && r.hitWindows > evmResult.hitWindows)) {
        evmResult = r;
        mainEvmChain = cid;
      }
    }

    let solResult = null;
    const solSwaps = swapsByChain[1399811149] || [];
    if (solSwaps.length > 0 || (evmResult && evmResult.address)) {
      report("sol_lookup", "正在进行 Solana 链上关联与跨链印证...", 1399811149, 95);
      solResult = await window.__lookupSol.solLookup(
        solSwaps,
        evmResult ? evmResult.address : null,
        (p) => report(p.phase, p.detail, 1399811149, 98)
      );
    }

    report("done", "反查完成！", null, 100);

    return {
      userId,
      hasSwaps: true,
      totalSwaps: swaps.length,
      totalEvmSwaps,
      mainEvmChain,
      evm: evmResult,
      sol: solResult,
      chainResults: Object.entries(evmResults).map(([cid, r]) => ({
        chainId: Number(cid),
        address: r && r.address ? r.address : null,
        confidence: r ? r.confidence : "none",
        scanned: r && r.stats ? r.stats.scanned : 0,
        aborted: r && r.aborted ? r.aborted : false,
        lastError: r && r.lastError ? r.lastError : null,
      })),
    };
  }

  function chainName(nid) {
    const names = { 1: "Ethereum", 56: "BSC", 8453: "Base", 4663: "Robinhood", 1399811149: "Solana" };
    return names[nid] || "Chain " + nid;
  }

  window.__lookup = { startLookup };
})();
