/* rpc.js — 链上 RPC 客户端
 * 封装 EVM (eth_*) 与 Solana JSON-RPC 调用
 * 全部使用公共免费节点，带限流 + 重试 + 指数退避
 */
(() => {
  "use strict";

  /* ========== RPC 端点映射 ========== */
  const EVM_RPCS = {
    8453:  ["https://mainnet.base.org", "https://base.llamarpc.com"],
    56:    [
      // 实测：binance 官方 seed 对 eth_getLogs 返回 limit exceeded，llamarpc 偶发 521；
      // 以下两个公共节点实测可正常拉 getLogs（热代币 13 块窗口 35 条日志）
      "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
      "https://rpc-bsc.48.club",
      "https://bsc-dataseed1.binance.org",
      "https://bsc-dataseed2.binance.org",
    ],
    4663:  ["https://rpc.mainnet.chain.robinhood.com", "https://rpc.ethos.cool"],  // Robinhood Chain
    1:     ["https://eth.llamarpc.com", "https://rpc.ankr.com/eth"],
  };

  const SOL_RPCS = [
    "https://api.mainnet-beta.solana.com",
  ];

  /* ========== 常量 ========== */
  // ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  // EIP-7702 委托前缀
  const EF0100 = "0xef0100";

  // 各链已验证的 FOMO 委托目标（eth_getCode 后 20 字节 = 目标合约）
  // 注意：Base(8453) 实测委托目标与 Robinhood(4663) 相同，均为 0xe6cae83bde06e4c305530e199d7217f42808555b
  // （旧配置 0xcae83bde06... 缺少 e6 前缀，导致 7702 指纹永远匹配失败 → 反查无结果）
  // 每链可配多个候选（数组），兼容 FOMO 后续更换委托合约
  const FOMO_DELEGATES = {
    4663: ["0xe6cae83bde06e4c305530e199d7217f42808555b"],
    8453: ["0xe6cae83bde06e4c305530e199d7217f42808555b"],
  };

  // 平均出块时间（秒）
  const BLOCK_TIME = { 8453: 2, 56: 3, 4663: 1.2, 1: 12 };

  // getLogs 单次最大块范围（公共 RPC 限制）
  const MAX_LOG_RANGE = 10;

  /* ========== 限流器 ========== */
  const _lastCall = {};  // chainKey -> timestamp
  const MIN_INTERVAL = 220; // ms，公共节点安全间隔

  async function throttle(key) {
    const now = Date.now();
    const last = _lastCall[key] || 0;
    const wait = Math.max(0, MIN_INTERVAL - (now - last));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastCall[key] = Date.now();
  }

  /* ========== EVM RPC 调用 ========== */
  async function evmRpc(chainId, method, params, retries = 3) {
    const endpoints = EVM_RPCS[chainId];
    if (!endpoints || !endpoints.length) throw new Error("不支持的链: " + chainId);

    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      const url = endpoints[attempt % endpoints.length];
      const key = "evm_" + chainId;
      await throttle(key);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        });

        if (res.status === 429) {
          // 限流，等待后重试
          const wait = Math.min(2000 * Math.pow(2, attempt), 15000);
          console.warn(`[rpc] ${chainId} 429 限流，等待 ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
          lastErr = new Error("429 Too Many Requests");
          continue;
        }

        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }

        const data = await res.json();
        if (data.error) {
          // 归档节点限制等
          if (/archive|authenticated/i.test(data.error.message || "")) {
            lastErr = new Error(data.error.message);
            continue;
          }
          throw new Error(data.error.message || JSON.stringify(data.error));
        }
        return data.result;
      } catch (e) {
        lastErr = e;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw lastErr || new Error("RPC 调用失败");
  }

  /* ========== EVM 高级方法 ========== */

  async function getBlockNumber(chainId) {
    const hex = await evmRpc(chainId, "eth_blockNumber", []);
    return parseInt(hex, 16);
  }

  async function getBlockByNumber(chainId, blockNum) {
    const hex = "0x" + blockNum.toString(16);
    const block = await evmRpc(chainId, "eth_getBlockByNumber", [hex, false]);
    if (!block) return null;
    return {
      number: parseInt(block.number, 16),
      timestamp: parseInt(block.timestamp, 16),
      hash: block.hash,
    };
  }

  /**
   * 拉 Transfer 日志，自动分片（每片 MAX_LOG_RANGE 块）
   * @returns {Array} 日志条目列表
   */
  async function getLogs(chainId, tokenAddress, fromBlock, toBlock) {
    const allLogs = [];
    for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
      const end = Math.min(start + MAX_LOG_RANGE - 1, toBlock);
      try {
        const logs = await evmRpc(chainId, "eth_getLogs", [{
          address: tokenAddress,
          topics: [TRANSFER_TOPIC],
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
        }]);
        if (Array.isArray(logs)) allLogs.push(...logs);
      } catch (e) {
        // 单片失败不中断，记录警告
        console.warn(`[rpc] getLogs 分片失败 ${start}-${end}:`, e.message);
      }
    }
    return allLogs;
  }

  async function getCode(chainId, address) {
    return evmRpc(chainId, "eth_getCode", [address, "latest"]);
  }

  // 读 ERC-20 decimals (标准 function selector = 0x313ce567)
  const _decimalsCache = {};
  async function getDecimals(chainId, tokenAddress) {
    const key = chainId + ":" + tokenAddress.toLowerCase();
    if (_decimalsCache[key] !== undefined) return _decimalsCache[key];
    try {
      const res = await evmRpc(chainId, "eth_call", [
        { to: tokenAddress, data: "0x313ce567" },
        "latest",
      ]);
      const d = parseInt(res, 16);
      _decimalsCache[key] = isNaN(d) ? 18 : d;
    } catch (_e) {
      _decimalsCache[key] = 18; // 默认
    }
    return _decimalsCache[key];
  }

  /* ========== EIP-7702 指纹检查 ========== */

  /**
   * 检查地址是否为 FOMO 的 EIP-7702 委托钱包
   * @returns {boolean}
   */
  async function isFomoDelegated(chainId, address) {
    try {
      const code = await getCode(chainId, address);
      if (!code || code === "0x" || code.length < 10) return false;
      const lower = code.toLowerCase();
      if (!lower.startsWith(EF0100)) return false;

      // 后 20 字节 = 委托目标
      const delegatee = "0x" + lower.slice(8); // ef0100 = 6 chars after 0x prefix → slice(8)
      const expectedList = FOMO_DELEGATES[chainId];
      if (!expectedList || !expectedList.length) {
        // 该链没有已知委托目标，但有 7702 前缀也算疑似
        return true;
      }
      return expectedList.some((exp) => delegatee.toLowerCase() === exp.toLowerCase());
    } catch (_e) {
      return false; // RPC 失败不算
    }
  }

  /* ========== Solana RPC ========== */

  async function solRpc(method, params, retries = 3) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      const url = SOL_RPCS[attempt % SOL_RPCS.length];
      await throttle("sol");

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        });

        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          lastErr = new Error("SOL 429");
          continue;
        }

        const data = await res.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        return data.result;
      } catch (e) {
        lastErr = e;
        if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw lastErr || new Error("Solana RPC 调用失败");
  }

  async function solGetSignaturesForAddress(address, opts = {}) {
    const params = [address];
    const options = {};
    if (opts.limit) options.limit = opts.limit;
    if (opts.before) options.before = opts.before;
    if (opts.until) options.until = opts.until;
    params.push(options);
    return solRpc("getSignaturesForAddress", params);
  }

  async function solGetTransaction(signature) {
    return solRpc("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  }

  /* ========== 工具函数 ========== */

  /** 将 bigint hex data 转为 human-readable 数量 */
  function hexToHumanAmount(hexData, decimals) {
    if (!hexData || hexData === "0x") return 0;
    // 处理大整数：用 BigInt
    try {
      const raw = BigInt(hexData);
      const divisor = BigInt(10 ** decimals);
      const intPart = raw / divisor;
      const fracPart = raw % divisor;
      const fracStr = fracPart.toString().padStart(decimals, "0");
      return parseFloat(intPart.toString() + "." + fracStr);
    } catch (_e) {
      return parseInt(hexData, 16) / (10 ** decimals);
    }
  }

  /** 从 Transfer 日志解析 from/to/value */
  function parseTransferLog(log) {
    return {
      from: "0x" + (log.topics[1] || "").slice(26),
      to: "0x" + (log.topics[2] || "").slice(26),
      rawValue: log.data,
      blockNumber: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
    };
  }

  /* ========== 导出 ========== */
  window.__rpc = {
    // EVM
    evmRpc,
    getBlockNumber,
    getBlockByNumber,
    getLogs,
    getCode,
    getDecimals,
    isFomoDelegated,
    // Solana
    solRpc,
    solGetSignaturesForAddress,
    solGetTransaction,
    // 工具
    hexToHumanAmount,
    parseTransferLog,
    // 常量
    TRANSFER_TOPIC,
    FOMO_DELEGATES,
    BLOCK_TIME,
    MAX_LOG_RANGE,
    EVM_RPCS,
    SOL_RPCS,
  };
})();
