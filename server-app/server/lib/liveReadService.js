'use strict';

// 网页和 MCP 共用采集器快照；有旧帧时更新不占用读取请求。
// 最近六分钟有读者才保温，覆盖五分钟巡检；无人读取后自动停表。
function createReader({ peek, refresh, warm, valid = () => true, intervalMs = 15000, leaseMs = 360000 }) {
  const entries = new Map();
  function entryFor(id) {
    if (!entries.has(id)) entries.set(id, { lastRead: 0, flight: null, timer: null });
    return entries.get(id);
  }
  function refreshOnce(id, entry) {
    if (!entry.flight) {
      const flight = Promise.resolve().then(() => refresh(id)).catch(() => {}).finally(() => {
        if (entry.flight === flight) entry.flight = null;
      });
      entry.flight = flight;
    }
    return entry.flight;
  }
  function schedule(id, entry) {
    if (entry.timer) return;
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (entries.get(id) !== entry || !valid(id) || Date.now() - entry.lastRead > leaseMs) { stop(id); return; }
      await refreshOnce(id, entry);
      if (entries.get(id) !== entry) return;
      // 慢模块自带去重和限频，不让它们阻塞下一轮核心采集。
      if (warm) void Promise.resolve().then(() => warm(id)).catch(() => {});
      schedule(id, entry);
    }, intervalMs);
    entry.timer.unref?.();
  }
  async function read(id) {
    const snapshot = peek(id);
    const entry = entryFor(id);
    entry.lastRead = Date.now();
    const flight = refreshOnce(id, entry);
    schedule(id, entry);
    // 冷启动仍等一次真实核验，不以空值冒充已经采集。
    if (!snapshot?.liveCheckedAt && !snapshot?.fetchedAt) await flight;
  }
  function stop(id) {
    const entry = entries.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    entries.delete(id);
  }
  return { read, stop };
}

const collector = () => require('./liveCollector');
const reader = createReader({
  peek: id => collector().getLatestWatch().find(a => a.accountId === id),
  valid: id => require('./config').QIANCHUAN_ACCOUNTS.some(a => a.id === id),
  refresh: id => collector().ensureLiveWatch(id),
  warm: async id => {
    if (process.env.QC_DISABLE_BACKGROUND !== '1') return;
    const watch = collector().getLatestWatch().find(a => a.accountId === id);
    if (watch?.isLive === true) await Promise.allSettled([
      collector().ensureLiveTrend(id), collector().ensureLiveFlow(id), collector().ensureLiveInsights(id),
    ]);
    else if (watch?.isLive === false) await require('../routes/liveDashboard').refreshEndedSnapshot(id);
  },
});

module.exports = { readLiveSnapshot: reader.read, stopLiveReader: reader.stop, createReader };
