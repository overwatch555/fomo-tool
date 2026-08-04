/* lookup_evm.js — EVM 链上地址反查引擎
 * 实现：时间戳对撞 → 候选收集 → 7702 指纹过滤 → 多窗口交叉 → 金额精确验证
 */
(() => {
  "use strict";

  const rpc = () => window.__rpc;

  /* ============ 步骤 1：时间戳 → 精确块号 ============ */

  /**
   * 将 UNIX 时间戳估算为链上块号
   * 方法：取当前块 + 基准块(当前-50000)，算真实平均间隔，再线性扫描微调
   */
  async function estimateBlock(chainId, targetTimeSec) {
    const curNum = await rpc().getBlockNumber(chainId);
    const curBlock = await rpc().getBlockByNumber(chainId, curNum);
    if (!curBlock) throw new Error("无法获取当前块");

    // 取基准块算真实平均出块间隔
    const sampleDist = Math.min(50000, curNum - 1);
    const baseNum = curNum - sampleDist;
    const baseBlock = await rpc().getBlockByNumber(chainId, baseNum);
    const avgBlockTime = baseBlock
      ? (curBlock.timestamp - baseBlock.timestamp) / sampleDist
      : rpc().BLOCK_TIME[chainId] || 2;

    // 初步估算
    const deltaTime = curBlock.timestamp - targetTimeSec;
    let estimated = Math.floor(curNum - deltaTime / avgBlockTime);
    estimated = Math.max(1, Math.min(estimated, curNum));

    // 线性扫描 ±30 块找最接近的
    const scanRange = 30;
    const from = Math.max(1, estimated - scanRange);
    const to = Math.min(curNum, estimated + scanRange);

    // 取两端和中间的块做插值（减少 RPC 调用）
    const probeNums = [from, estimated, to];
    const probes = {};
    for (const n of probeNums) {
      const b = await rpc().getBlockByNumber(chainId, n);
      if (b) probes[n] = b.timestamp;
    }

    // 在已知点之间二分找最近
    let best = estimated;
    let bestDelta = Math.abs((probes[estimated] || curBlock.timestamp) - targetTimeSec);
    for (const [numStr, ts] of Object.entries(probes)) {
      const d = Math.abs(ts - targetTimeSec);
      if (d < bestDelta) {
        bestDelta = d;
        best = Number(numStr);
      }
    }

    return { blockNumber: best, timestampDelta: bestDelta };
  }

  /* ============ 步骤 2：收集候选地址 ============ */

  /**
   * 在指定块范围内拉 Transfer 事件，收集候选地址
   * @param {string} direction - "buy" = 用户是接收方(to), "sell" = 用户是转出方(from)
   * @returns {Map<string, {count, values[], txHashes[]}>} 候选地址 → 数据
   */
  async function collectCandidates(chainId, tokenAddress, centerBlock, windowBlocks, direction) {
    const fromBlock = Math.max(1, centerBlock - windowBlocks);
    const toBlock = centerBlock + windowBlocks;
    const logs = await rpc().getLogs(chainId, tokenAddress, fromBlock, toBlock);
    const candidates = new Map();

    for (const log of logs) {
      const parsed = rpc().parseTransferLog(log);
      // 根据买入/卖出确定关注哪个地址
      const addr = (direction === "buy" ? parsed.to : parsed.from).toLowerCase();
      if (!addr || addr === "0x0000000000000000000000000000000000000000") continue;

      const entry = candidates.get(addr) || { count: 0, values: [], txHashes: [], blocks: [] };
      entry.count++;
      entry.values.push(parsed.rawValue);
      entry.txHashes.push(parsed.txHash);
      entry.blocks.push(parsed.blockNumber);
      candidates.set(addr, entry);
    }
    return candidates;
  }

  /* ============ 步骤 3：EIP-7702 指纹过滤 ============ */

  /**
   * 对候选地址集做指纹过滤，只保留 FOMO 委托钱包
   * 并发限制 4，避免打爆公共 RPC
   */
  async function filterByFingerprint(chainId, addressSet) {
    const addrs = [...addressSet];
    const passed = new Set();
    const CONCURRENCY = 4;
    let idx = 0;

    async function worker() {
      while (idx < addrs.length) {
        const addr = addrs[idx++];
        try {
          const is7702 = await rpc().isFomoDelegated(chainId, addr);
          if (is7702) passed.add(addr);
        } catch (_e) {
          // 跳过失败的
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addrs.length) }, worker));
    return passed;
  }

  /* ============ 步骤 4：多窗口交叉验证 ============ */

  /**
   * 统计每个地址在多少个独立窗口中出现
   * @param {Array<Map<string, any>>} windowCandidates - 每个窗口的候选集
   * @returns {Array<{address, hitWindows, totalWindows, windowDetail[]}>}
   */
  function crossValidate(windowCandidates) {
    const counter = new Map(); // addr -> { hitWindows, detail[] }
    const total = windowCandidates.length;

    windowCandidates.forEach((candidates, winIdx) => {
      for (const [addr, data] of candidates) {
        const entry = counter.get(addr) || { hitWindows: 0, detail: [] };
        entry.hitWindows++;
        entry.detail.push({ windowIndex: winIdx, ...data });
        counter.set(addr, entry);
      }
    });

    // 按命中窗口数降序排列
    return [...counter.entries()]
      .map(([address, info]) => ({
        address,
        hitWindows: info.hitWindows,
        totalWindows: total,
        hitRate: (info.hitWindows / total * 100).toFixed(1) + "%",
        windowDetail: info.detail,
      }))
      .sort((a, b) => b.hitWindows - a.hitWindows);
  }

  /* ============ 步骤 5：金额精确验证 ============ */

  /**
   * 对指定地址在窗口内做金额对账
   * @returns {{ match: boolean, chainAmount: number, apiAmount: number, delta: number }}
   */
  async function verifyAmount(chainId, address, tokenAddress, centerBlock, windowBlocks, expectedAmount, direction) {
    const fromBlock = Math.max(1, centerBlock - windowBlocks);
    const toBlock = centerBlock + windowBlocks;
    const logs = await rpc().getLogs(chainId, tokenAddress, fromBlock, toBlock);
    const decimals = await rpc().getDecimals(chainId, tokenAddress);

    for (const log of logs) {
      const parsed = rpc().parseTransferLog(log);
      const addr = (direction === "buy" ? parsed.to : parsed.from).toLowerCase();
      if (addr !== address.toLowerCase()) continue;

      const chainAmount = rpc().hexToHumanAmount(parsed.rawValue, decimals);
      const delta = Math.abs(chainAmount - expectedAmount);
      const relDelta = expectedAmount > 0 ? delta / expectedAmount : delta;

      if (relDelta < 0.001) { // 0.1% 以内算精确匹配
        return { match: true, chainAmount, apiAmount: expectedAmount, delta, txHash: parsed.txHash };
      }
    }
    return { match: false, chainAmount: 0, apiAmount: expectedAmount, delta: Infinity };
  }

  /* ============ 主入口 ============ */

  /**
   * EVM 链反查主函数
   * @param {Array} swaps - 某条 EVM 链上的 swap 记录（来自 FOMO API）
   * @param {number} chainId
   * @param {Function} onProgress - 进度回调 (step, detail)
   * @returns {Object} { address, confidence, evidence[], stats }
   */
  async function evmLookup(swaps, chainId, onProgress) {
    const report = (step, detail) => {
      if (onProgress) onProgress({ phase: step, detail, chainId });
    };

    if (!swaps || !swaps.length) {
      return { address: null, confidence: "none", evidence: [], stats: { total: 0, scanned: 0 } };
    }

    // 取最近 20 笔有效的 swap（有代币地址和时间）
    const validSwaps = swaps
      .filter((s) => s.createdAt && (s.inTokenAddress || s.outTokenAddress))
      .slice(0, 20);

    if (!validSwaps.length) {
      console.warn("[lookup_evm] 无有效 swap（缺 createdAt / inTokenAddress / outTokenAddress）：",
        swaps[0] && JSON.stringify(swaps[0]).slice(0, 800));
    } else {
      console.log("[lookup_evm] validSwaps:", validSwaps.length,
        JSON.stringify(validSwaps[0]).slice(0, 500));
    }

    report("estimating_blocks", `准备对 ${validSwaps.length} 笔交易做时间戳对撞...`);

    const windowBlocks = 25; // ±25 块窗口
    const windowResults = []; // 每个窗口的 filtered candidates
    const allCandidatesPerWindow = []; // 交叉验证用
    const evidence = [];
    let errStreak = 0;      // 连续 RPC 失败计数（熔断用）
    let aborted = false;    // 是否因 RPC 全线故障提前退出
    let lastError = null;

    for (let i = 0; i < validSwaps.length; i++) {
      // RPC 连续失败熔断：避免在挂掉的公共节点上空转 20 轮
      if (errStreak >= 4) {
        aborted = true;
        lastError = evidence[evidence.length - 1].error;
        console.warn(`[lookup_evm] chain ${chainId} RPC 连续失败，提前中止（${lastError}）`);
        break;
      }
      const swap = validSwaps[i];
      const time = new Date(swap.createdAt).getTime() / 1000;

      // 判断买入/卖出：inTokenAddress 是 quote 资产（稳定币/WETH/原生）→ 买入
      // 覆盖：Solana USDC(EPjFWdd5)/wSOL；Base USDC(0x833589)/USDT(0x50c5725949)/桥接USDC(0xd9aAEc86)/WETH(0x4200..06)/原生ETH
      const QUOTE_RE = /^(EPjFWdd5|So11111111111111111111111111111111111111112|0x833589|0x50c5725949|0xd9aAEc86|0x4200000000000000000000000000000000000006|0x0000000000000000000000000000000000000000|0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)/i;
      const isUSDCIn = QUOTE_RE.test(swap.inTokenAddress || "");
      const direction = isUSDCIn ? "buy" : "sell";
      const tokenAddress = isUSDCIn ? swap.outTokenAddress : swap.inTokenAddress;

      // 跳过非 EVM 代币地址
      if (!tokenAddress || !tokenAddress.startsWith("0x")) continue;

      report("scanning_logs", `[${i + 1}/${validSwaps.length}] 估算块号并拉取 Transfer 事件...`);

      try {
        // 步骤 1: 估块
        const { blockNumber } = await estimateBlock(chainId, time);

        // 步骤 2: 收集候选
        const candidates = await collectCandidates(chainId, tokenAddress, blockNumber, windowBlocks, direction);

        if (candidates.size === 0) {
          evidence.push({ swapIndex: i, status: "no_logs", blockNumber });
          continue;
        }

        // 步骤 3: 指纹过滤
        report("fingerprinting", `[${i + 1}/${validSwaps.length}] 对 ${candidates.size} 个候选做 7702 指纹检查...`);
        const fomoAddrs = await filterByFingerprint(chainId, candidates.keys());

        // 构造过滤后的候选 Map
        const filtered = new Map();
        for (const addr of fomoAddrs) {
          if (candidates.has(addr)) filtered.set(addr, candidates.get(addr));
        }

        allCandidatesPerWindow.push(filtered);

        evidence.push({
          swapIndex: i,
          status: "scanned",
          blockNumber,
          rawCandidates: candidates.size,
          fomoFiltered: filtered.size,
          token: tokenAddress,
          direction,
          time: swap.createdAt,
          amount: direction === "buy" ? swap.outHumanAmount : swap.inHumanAmount,
        });
        errStreak = 0;

      } catch (e) {
        evidence.push({ swapIndex: i, status: "error", error: e.message });
        lastError = e.message;
        errStreak++;
      }
    }

    // 步骤 4: 多窗口交叉验证
    report("cross_validating", `正在交叉验证 ${allCandidatesPerWindow.length} 个窗口的候选地址...`);
    const ranked = crossValidate(allCandidatesPerWindow);

    if (!ranked.length) {
      return {
        address: null,
        confidence: "none",
        evidence,
        aborted,
        lastError,
        stats: { total: validSwaps.length, scanned: allCandidatesPerWindow.length, candidates: 0 },
      };
    }

    const topCandidate = ranked[0];

    // 步骤 5: 对 Top 候选做金额验证（最多验 3 个窗口）
    let amountMatches = 0;
    const amountEvidence = [];

    report("amount_verifying", `对首选地址 ${topCandidate.address.slice(0, 10)}... 做金额精确对账...`);

    for (const ev of evidence.filter((e) => e.status === "scanned").slice(0, 3)) {
      try {
        const expectedAmount = Number(ev.amount);
        if (!expectedAmount || isNaN(expectedAmount)) continue;

        const time = new Date(ev.time).getTime() / 1000;
        const { blockNumber } = await estimateBlock(chainId, time);

        const result = await verifyAmount(
          chainId, topCandidate.address, ev.token,
          blockNumber, windowBlocks, expectedAmount, ev.direction
        );
        amountEvidence.push({ ...result, swapIndex: ev.swapIndex });
        if (result.match) amountMatches++;
      } catch (_e) {
        // 忽略单笔验证失败
      }
    }

    // 确定置信度
    let confidence;
    if (amountMatches >= 2) confidence = "iron";           // 铁证
    else if (amountMatches >= 1 && topCandidate.hitWindows >= 5) confidence = "iron";
    else if (topCandidate.hitWindows >= 5) confidence = "strong";  // 强证据
    else if (topCandidate.hitWindows >= 2) confidence = "moderate"; // 中等
    else confidence = "weak";                              // 弱线索

    report("done", `反查完成！置信度: ${confidence}`);

    return {
      address: topCandidate.address,
      confidence,
      hitWindows: topCandidate.hitWindows,
      totalWindows: topCandidate.totalWindows,
      hitRate: topCandidate.hitRate,
      amountMatches,
      amountEvidence,
      evidence,
      aborted,
      lastError,
      allRanked: ranked.slice(0, 5), // 返回前 5 候选
      stats: {
        total: validSwaps.length,
        scanned: allCandidatesPerWindow.length,
        candidates: ranked.length,
      },
    };
  }

  /* ========== 导出 ========== */
  window.__lookupEvm = { evmLookup, estimateBlock, collectCandidates, filterByFingerprint, crossValidate, verifyAmount };
})();
