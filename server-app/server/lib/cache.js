const fs = require('fs');
const path = require('path');
const { CACHE_DIR, CACHE_TTL_MS } = require('./config');

// /api/data 路由直接用此 Map 缓存聚合结果，key 形如 "accountId|start~end"。
// 带容量上限：超过 MAX_ENTRIES 时淘汰最旧条目，防止内存无限增长。
const MAX_ENTRIES = 100;
const _raw = new Map();
const _accessOrder = [];

const memoryCache = {
  get(key) {
    return _raw.get(key);
  },
  set(key, value) {
    if (_raw.has(key)) {
      _raw.set(key, value);
      return;
    }
    if (_accessOrder.length >= MAX_ENTRIES) {
      const oldest = _accessOrder.shift();
      _raw.delete(oldest);
    }
    _raw.set(key, value);
    _accessOrder.push(key);
  },
  delete(key) {
    const idx = _accessOrder.indexOf(key);
    if (idx >= 0) _accessOrder.splice(idx, 1);
    return _raw.delete(key);
  },
  has(key) {
    return _raw.has(key);
  },
  get size() {
    return _raw.size;
  },
};

/**
 * 通用 TTL 内存缓存工厂。
 * @param {number} defaultTtlMs - 默认过期时间（毫秒）
 * @returns {{get, set, delete, clear, size}}
 */
const _ttlStores = [];
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const store of _ttlStores) {
    for (const [key, entry] of store.entries()) {
      if (now - entry.ts >= entry.ttl) {
        store.delete(key);
      }
    }
  }
}, 5 * 60 * 1000);
_cleanupInterval.unref();

function createTTLCache(defaultTtlMs) {
  const store = new Map();
  _ttlStores.push(store);
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.ts >= entry.ttl) {
        store.delete(key);
        return undefined;
      }
      return entry.data;
    },
    set(key, data, ttlMs) {
      store.set(key, { data, ts: Date.now(), ttl: ttlMs || defaultTtlMs });
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    get size() {
      return store.size;
    },
  };
}

module.exports = {
  memoryCache,
  createTTLCache,
};
