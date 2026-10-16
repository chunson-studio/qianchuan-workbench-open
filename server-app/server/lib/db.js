const { metricNumber, marketingGoal } = require('./materialMetricFields');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error('[db] 需要 Node.js >=22.5（当前环境不支持 node:sqlite），请升级运行环境');
}
const path = require('path');
const fs = require('fs');
const { CACHE_DIR } = require('./config');
const { num, formatDate } = require('./utils');
const { defaultAccountId } = require('./api-helpers');

const DB_PATH = path.join(CACHE_DIR, 'material_history.db');

let db = null;

/**
 * 获取（单例）SQLite 数据库连接，首次调用时初始化 schema。
 * @returns {import('node:sqlite').DatabaseSync} 数据库实例
 */
function getDB() {
  if (db) return db;
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log('[db] opening database at', DB_PATH);
  try {
    db = new DatabaseSync(DB_PATH);
  } catch (e) {
    console.error('[db] failed to open database at', DB_PATH, ':', e.message);
    console.error('[db] stack:', e.stack || 'N/A');
    throw e;
  }
  // WAL: 读不阻塞写、写不阻塞读，多人同时用看板时不卡顿；
  // 同步 SQLite 若等锁 5 秒会冻结整个 Node 事件循环；250ms 内拿不到锁就快速失败，
  // 路由层统一映射为 503 db_busy，释放请求后由下一轮自动恢复。
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=250;');
  // 性能优化：增大缓存；2026-08-11 事故修复——Windows 上 mmap 256MB + 强杀 → torn page 损坏，
  // 禁用 mmap（0）并以 FULL 同步（每次提交 fsync）。写入为分钟级批量，性能损失可接受，换强杀/掉电安全
  db.exec('PRAGMA cache_size=-64000;');       // 64MB 页缓存
  db.exec('PRAGMA mmap_size=0;');             // 禁用 mmap（Windows 强杀风险，2026-08-11 事故修复）
  db.exec('PRAGMA synchronous=FULL;');        // WAL+FULL：抗强杀/掉电（原 NORMAL 在强杀下可能页错乱）
  db.exec('PRAGMA temp_store=MEMORY;');       // 临时表放内存
  // 退出时把 WAL checkpoint 回主库，缩小异常退出时的损坏窗口（2026-08-11 事故修复）
  process.on('exit', () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} });
  initSchema();
  return db;
}

/**
 * 初始化数据库 schema，含建表、列迁移与主键重建（幂等执行）。
 * @returns {void}
 */
function initSchema() {
  const currentVersion = db.prepare('PRAGMA user_version').get().user_version;
  const SCHEMA_VERSION = 3; // 当前schema版本

  // 基础建表 + 基础索引（每次启动幂等执行，IF NOT EXISTS 保证安全）
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_daily (
      account_id    TEXT NOT NULL DEFAULT '',
      material_id   TEXT NOT NULL,
      stat_date     TEXT NOT NULL,
      material_name TEXT,
      material_type TEXT,
      duration      TEXT,
      created_at    TEXT,
      source        TEXT,
      tags          TEXT,
      status        TEXT,
      cost          REAL DEFAULT 0,
      gmv           REAL DEFAULT 0,
      net_gmv       REAL DEFAULT 0,
      basic_cost    REAL DEFAULT 0,
      basic_gmv     REAL DEFAULT 0,
      additional_cost REAL DEFAULT 0,
      additional_gmv  REAL DEFAULT 0,
      additional_net_gmv REAL DEFAULT 0,
      additional_roi  REAL DEFAULT 0,
      orders        INTEGER DEFAULT 0,
      plays         INTEGER DEFAULT 0,
      clicks        INTEGER DEFAULT 0,
      cpc           REAL DEFAULT 0,
      finish_rate   REAL DEFAULT 0,
      rate5s        REAL DEFAULT 0,
      likes         INTEGER DEFAULT 0,
      follows       INTEGER DEFAULT 0,
      comments      INTEGER DEFAULT 0,
      cvr           REAL DEFAULT 0,
      live_cvr      REAL DEFAULT 0,
      refund_rate   REAL DEFAULT 0,
      tier          TEXT,
      role          TEXT,
      lifecycle_phase TEXT,
      fetched_at    TEXT,
      marketing_goal INTEGER DEFAULT 2,
      PRIMARY KEY (account_id, material_id, stat_date, marketing_goal)
    );
    CREATE INDEX IF NOT EXISTS idx_material_daily_date ON material_daily(stat_date);
    CREATE INDEX IF NOT EXISTS idx_material_daily_material ON material_daily(material_id);

    -- 盘中临时库（2026-08-06 维护者立项）：千川实时素材快照落盘，供当天评估参考 + 盘中 vs 终值对账。
    -- 只作参考严禁判杀；与 material_daily(T+1终值) 完全隔离，互不污染。
    CREATE TABLE IF NOT EXISTS material_intraday (
      account_id    TEXT NOT NULL,
      material_id   TEXT NOT NULL,
      snapshot_time TEXT NOT NULL,
      stat_date     TEXT NOT NULL,
      material_name TEXT,
      status        TEXT,
      cost          REAL DEFAULT 0,
      net_gmv_1h    REAL DEFAULT 0,
      orders        INTEGER DEFAULT 0,
      refund_rate   REAL DEFAULT 0,
      boost_cost    REAL DEFAULT 0,
      boost_settle_roi REAL DEFAULT 0,
      net_roi_1h    REAL,
      shows         INTEGER DEFAULT 0,
      clicks        INTEGER DEFAULT 0,
      cpc           REAL DEFAULT 0,
      click_rate    REAL DEFAULT 0,
      convert_rate  REAL DEFAULT 0,
      net_data_valid INTEGER DEFAULT 0,
      fetched_at    TEXT,
      PRIMARY KEY (account_id, material_id, snapshot_time)
    );
    CREATE INDEX IF NOT EXISTS idx_material_intraday_date ON material_intraday(account_id, stat_date);
    CREATE INDEX IF NOT EXISTS idx_material_intraday_snapshot ON material_intraday(account_id, stat_date, snapshot_time);
  `);

  // v8: 盘中净成交字段有效性。旧快照默认 0，避免把历史字段映射故障写出的 0 当成真实零成交。
  try {
    db.exec('ALTER TABLE material_intraday ADD COLUMN net_data_valid INTEGER DEFAULT 0;');
  } catch (e) {
    // 列已存在，忽略
  }

  // 平台累计净 ROI 原值单独保存；旧行保持 NULL，不用金额/消耗补算。
  if (!db.prepare("PRAGMA table_info('material_intraday')").all().some(column => column.name === 'net_roi_1h')) {
    db.exec('ALTER TABLE material_intraday ADD COLUMN net_roi_1h REAL;');
  }

  // v1: 添加新列（旧库无这些列）
  if (currentVersion < 1) {
    const newColumns = [
      'basic_cost REAL DEFAULT 0',
      'basic_gmv REAL DEFAULT 0',
      'additional_cost REAL DEFAULT 0',
      'additional_gmv REAL DEFAULT 0',
      'additional_net_gmv REAL DEFAULT 0',
      'additional_roi REAL DEFAULT 0',
      'tier TEXT',
      'role TEXT',
      'lifecycle_phase TEXT',
      'account_id TEXT NOT NULL DEFAULT \'\'',
      'settled_roi_1h REAL DEFAULT 0',
      'settled_roi_7d REAL DEFAULT 0',
      'avg_watch_time REAL DEFAULT 0',
      'rate3s REAL DEFAULT 0',
    ];
    for (const col of newColumns) {
      try {
        db.exec(`ALTER TABLE material_daily ADD COLUMN ${col};`);
      } catch (e) {
        // 列已存在，忽略
      }
    }
  }

  // v3: 添加净成交/追投/展现列（独立于版本检查，每次启动都确保存在）
  {
    const v3Columns = [
      'settled_orders INTEGER DEFAULT 0',
      'boost_refund_rate REAL DEFAULT 0',
      'shows INTEGER DEFAULT 0',
    ];
    for (const col of v3Columns) {
      try {
        db.exec(`ALTER TABLE material_daily ADD COLUMN ${col};`);
      } catch (e) {
        // 列已存在，忽略
      }
    }
  }

  // v4: 1h 结算净成交列（2026-07-21 口径纠错）。
  // net_gmv 历史误存实付GMV(total_pay_order_gmv_for_roi2，不扣退款)，标脏保留勿用；
  // 真净成交（扣1h退款，千川 total_order_settle_amount_for_roi2_1h）统一走 net_gmv_1h。
  {
    const v4Columns = [
      'net_gmv_1h REAL DEFAULT 0',
    ];
    for (const col of v4Columns) {
      try {
        db.exec(`ALTER TABLE material_daily ADD COLUMN ${col};`);
      } catch (e) {
        // 列已存在，忽略
      }
    }
  }

  // v5: 渠道列（2026-07-22 乘方商品卡接入）。2=推直播间（历史默认），1=推商品（商品卡/乘方）。
  {
    const v5Columns = [
      'marketing_goal INTEGER DEFAULT 2',
    ];
    for (const col of v5Columns) {
      try {
        db.exec(`ALTER TABLE material_daily ADD COLUMN ${col};`);
      } catch (e) {
        // 列已存在，忽略
      }
    }
  }

  // v6: 主键升级为 (account_id, material_id, stat_date, marketing_goal)。
  // 实测同一视频同日既在直播计划又在商品卡计划（不同消耗/成交），三列主键下两渠道互相覆盖丢数据。
  rebuildTableForGoalPK(db);

  // 仅增加来源列；历史字段修复必须走显式、可回滚的数据维护。
  const dailyColumns = new Set(db.prepare('PRAGMA table_info(material_daily)').all().map(c => c.name));
  for (const [name, type] of [['metric_sources_json', 'TEXT'], ['additional_net_gmv_basis', 'TEXT']]) {
    if (!dailyColumns.has(name)) db.exec('ALTER TABLE material_daily ADD COLUMN ' + name + ' ' + type);
  }

  // v7: material_insight 增加 click_count / drop_count，把秒级留存拆回整体点击次数和整体流失次数。
  {
    const v7Columns = [
      'click_count INTEGER DEFAULT 0',
      'drop_count INTEGER DEFAULT 0',
    ];
    for (const col of v7Columns) {
      try {
        db.exec(`ALTER TABLE material_insight ADD COLUMN ${col};`);
      } catch (e) {
        // 列已存在，忽略
      }
    }
  }

  // v9: 素材漏斗补齐真实进房点击与点击单价。旧版把 plays/shows 误作 CTR，
  // 无法表达真实获客阻力；新列允许用 cost/clicks 计算跨日 CPC。
  {
    const v9DailyColumns = [
      'clicks INTEGER DEFAULT 0',
      'cpc REAL DEFAULT 0',
    ];
    for (const col of v9DailyColumns) {
      try { db.exec(`ALTER TABLE material_daily ADD COLUMN ${col};`); } catch { /* 已存在 */ }
    }
    const v9IntradayColumns = [
      'shows INTEGER DEFAULT 0',
      'clicks INTEGER DEFAULT 0',
      'cpc REAL DEFAULT 0',
      'click_rate REAL DEFAULT 0',
      'convert_rate REAL DEFAULT 0',
    ];
    for (const col of v9IntradayColumns) {
      try { db.exec(`ALTER TABLE material_intraday ADD COLUMN ${col};`); } catch { /* 已存在 */ }
    }
  }

// v6 迁移：主键纳入 marketing_goal（直播/商品双渠道同素材同日共存）。
// 通过新建表 → 拷贝 → 删旧 → 改名 绕过 SQLite 不支持 ALTER PK 的限制（与 rebuildTableForAccountPK 同法）。
function rebuildTableForGoalPK(db) {
  const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_daily'").get();
  if (!tbl || !tbl.sql) return;
  if (/PRIMARY KEY\s*\([^)]*marketing_goal/i.test(tbl.sql)) return;
  console.log('[db] 主键升级：material_daily 纳入 marketing_goal（双渠道共存），重建中...');
  // clicks/cpc 是 v9 才出现的列；v6 旧库升级发生在 v9 ALTER 之前，
  // 因此迁移复制清单不能引用它们，新表使用 DEFAULT 0，随后 v9 起正常采集。
  const COLS = 'account_id, material_id, stat_date, material_name, material_type, duration, created_at, source, tags, status, cost, gmv, net_gmv, basic_cost, basic_gmv, additional_cost, additional_gmv, additional_net_gmv, additional_roi, orders, plays, finish_rate, rate5s, likes, follows, comments, cvr, live_cvr, refund_rate, tier, role, lifecycle_phase, settled_roi_1h, settled_roi_7d, avg_watch_time, rate3s, settled_orders, boost_refund_rate, shows, net_gmv_1h, marketing_goal, fetched_at';
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE material_daily_goalpk (
        account_id    TEXT NOT NULL DEFAULT '',
        material_id   TEXT NOT NULL,
        stat_date     TEXT NOT NULL,
        material_name TEXT,
        material_type TEXT,
        duration      TEXT,
        created_at    TEXT,
        source        TEXT,
        tags          TEXT,
        status        TEXT,
        cost          REAL DEFAULT 0,
        gmv           REAL DEFAULT 0,
        net_gmv       REAL DEFAULT 0,
        basic_cost    REAL DEFAULT 0,
        basic_gmv     REAL DEFAULT 0,
        additional_cost REAL DEFAULT 0,
        additional_gmv  REAL DEFAULT 0,
        additional_net_gmv REAL DEFAULT 0,
        additional_roi  REAL DEFAULT 0,
        orders        INTEGER DEFAULT 0,
        plays         INTEGER DEFAULT 0,
        clicks        INTEGER DEFAULT 0,
        cpc           REAL DEFAULT 0,
        finish_rate   REAL DEFAULT 0,
        rate5s        REAL DEFAULT 0,
        likes         INTEGER DEFAULT 0,
        follows       INTEGER DEFAULT 0,
        comments      INTEGER DEFAULT 0,
        cvr           REAL DEFAULT 0,
        live_cvr      REAL DEFAULT 0,
        refund_rate   REAL DEFAULT 0,
        tier          TEXT,
        role          TEXT,
        lifecycle_phase TEXT,
        settled_roi_1h REAL DEFAULT 0,
        settled_roi_7d REAL DEFAULT 0,
        avg_watch_time REAL DEFAULT 0,
        rate3s        REAL DEFAULT 0,
        settled_orders INTEGER DEFAULT 0,
        boost_refund_rate REAL DEFAULT 0,
        shows         INTEGER DEFAULT 0,
        net_gmv_1h    REAL DEFAULT 0,
        marketing_goal INTEGER DEFAULT 2,
        fetched_at    TEXT,
        PRIMARY KEY (account_id, material_id, stat_date, marketing_goal)
      );
    `);
    db.exec(`INSERT INTO material_daily_goalpk (${COLS}) SELECT ${COLS} FROM material_daily`);
    db.exec('DROP TABLE material_daily');
    db.exec('ALTER TABLE material_daily_goalpk RENAME TO material_daily');
    db.exec('CREATE INDEX IF NOT EXISTS idx_material_daily_date ON material_daily(stat_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_material_daily_material ON material_daily(material_id)');
    db.exec('COMMIT');
    console.log('[db] 主键升级完成');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

  // v2: 重建表（把 account_id 纳入主键）+ account_id 相关索引
  if (currentVersion < 2) {
    // 兼容旧库主键：ALTER TABLE 无法修改 PK，旧库的 PRIMARY KEY 仍是 (material_id, stat_date)，
    // 会导致多账号同素材同日数据互相覆盖。这里检测后整表重建，把 account_id 纳入唯一约束。
    rebuildTableForAccountPK(db);

    // account_id 索引必须在 account_id 列存在后再建（旧库迁移前该列没有），
    // 故放在 ALTER + rebuild 之后，否则旧库首次启动会 "no such column: account_id"。
    db.exec(`CREATE INDEX IF NOT EXISTS idx_material_daily_account ON material_daily(account_id);
      CREATE INDEX IF NOT EXISTS idx_material_daily_composite ON material_daily(account_id, stat_date, material_id);
      CREATE INDEX IF NOT EXISTS idx_material_daily_acc_mat_date ON material_daily(account_id, material_id, stat_date);
      CREATE INDEX IF NOT EXISTS idx_material_daily_acc_cost ON material_daily(account_id, cost);`);
  }

  // 素材深度数据表（秒级留存/人群画像/追投任务/脚本/创意元素）
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_insight (
      account_id TEXT NOT NULL DEFAULT '',
      material_id TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      total_seconds INTEGER DEFAULT 0,
      lose_rate_5s REAL DEFAULT 0,
      click_count INTEGER DEFAULT 0,
      drop_count INTEGER DEFAULT 0,
      seconds_json TEXT,
      fetched_at TEXT,
      PRIMARY KEY (account_id, material_id, stat_date)
    );
    CREATE TABLE IF NOT EXISTS material_crowd (
      account_id TEXT NOT NULL DEFAULT '',
      material_id TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      crowd_json TEXT,
      fetched_at TEXT,
      PRIMARY KEY (account_id, material_id, stat_date)
    );
    CREATE TABLE IF NOT EXISTS material_boost_task (
      account_id TEXT NOT NULL DEFAULT '',
      material_id TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      tasks_json TEXT,
      fetched_at TEXT,
      PRIMARY KEY (account_id, material_id, stat_date)
    );
    CREATE TABLE IF NOT EXISTS material_content (
      account_id TEXT NOT NULL DEFAULT '',
      material_id TEXT NOT NULL,
      stat_date TEXT NOT NULL,
      script_json TEXT,
      creative_json TEXT,
      fetched_at TEXT,
      PRIMARY KEY (account_id, material_id, stat_date)
    );
    CREATE INDEX IF NOT EXISTS idx_material_insight_material ON material_insight(material_id);
    CREATE INDEX IF NOT EXISTS idx_material_crowd_material ON material_crowd(material_id);
    CREATE INDEX IF NOT EXISTS idx_material_boost_task_material ON material_boost_task(material_id);
    CREATE INDEX IF NOT EXISTS idx_material_content_material ON material_content(material_id);
  `);

  // MHS 素材健康分：每日特征快照表（2026-07-28 §七-1）。
  // stat_date = 特征计算基准日（数据截止日，T+1 口径=昨天）；mhs/tier 在公式未标定时为 NULL。
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_features (
      account_id    TEXT NOT NULL,
      material_id   TEXT NOT NULL,
      stat_date     TEXT NOT NULL,
      age_days      INTEGER,
      role          TEXT,
      decay_weighted_roi REAL,
      cost_momentum REAL,
      roi_momentum  REAL,
      ctr           REAL,
      ctr_rel       REAL,
      retention_5s  REAL,
      boost_response REAL,
      cost_share_7d REAL,
      gmv_share_7d  REAL,
      benefit_score REAL,
      trend_score   REAL,
      potential_score REAL,
      age_decay     REAL,
      mhs           REAL,
      tier          TEXT,
      params_version TEXT,
      features_json TEXT,
      computed_at   TEXT,
      PRIMARY KEY (account_id, material_id, stat_date)
    );
    CREATE INDEX IF NOT EXISTS idx_material_features_date ON material_features(account_id, stat_date);
    CREATE INDEX IF NOT EXISTS idx_material_features_material ON material_features(account_id, material_id, stat_date);

    -- 直播复盘三表（2026-08-03 维护者指令：场次与素材同级入库，秒查+SQL聚合）
    CREATE TABLE IF NOT EXISTS live_sessions (
      account_id    TEXT NOT NULL,
      room_id       TEXT NOT NULL,
      room_name     TEXT,
      start_time    TEXT NOT NULL DEFAULT '',
      end_time      TEXT,
      status        TEXT,
      cost          REAL DEFAULT 0,
      gmv           REAL DEFAULT 0,
      net_gmv       REAL DEFAULT 0,
      orders        INTEGER DEFAULT 0,
      source        TEXT,
      fetched_at    TEXT,
      PRIMARY KEY (account_id, room_id, start_time)
    );
    CREATE INDEX IF NOT EXISTS idx_live_sessions_start ON live_sessions(account_id, start_time);

    CREATE TABLE IF NOT EXISTS live_session_trend (
      account_id    TEXT NOT NULL,
      room_id       TEXT NOT NULL,
      start_time    TEXT NOT NULL DEFAULT '',
      point_time    TEXT NOT NULL,
      cost          REAL DEFAULT 0,
      orders        INTEGER DEFAULT 0,
      gmv           REAL DEFAULT 0,
      net_1h        REAL DEFAULT 0,
      cost_all      REAL DEFAULT 0,
      PRIMARY KEY (account_id, room_id, start_time, point_time)
    );
    CREATE INDEX IF NOT EXISTS idx_live_trend_time ON live_session_trend(account_id, point_time);

    -- 当前场次基础/追投累计消耗采样。持久化后，Agent 晚启动或 HTTP 服务重启
    -- 不需要重新等待完整15分钟，仍可用同场历史基线计算拆分流速。
    CREATE TABLE IF NOT EXISTS live_flow_samples (
      account_id    TEXT NOT NULL,
      session_key   TEXT NOT NULL,
      sample_time   TEXT NOT NULL,
      total_cost    REAL NOT NULL,
      assist_cost   REAL NOT NULL,
      PRIMARY KEY (account_id, session_key, sample_time)
    );
    CREATE INDEX IF NOT EXISTS idx_live_flow_samples_time
      ON live_flow_samples(account_id, session_key, sample_time);

    CREATE TABLE IF NOT EXISTS live_session_actions (
      account_id    TEXT NOT NULL,
      room_id       TEXT NOT NULL,
      start_time    TEXT NOT NULL DEFAULT '',
      action_ts     INTEGER NOT NULL,
      action_type   TEXT NOT NULL DEFAULT '',
      action_text   TEXT,
      kind          TEXT,
      PRIMARY KEY (account_id, room_id, start_time, action_ts, action_type)
    );
  `);

  ensureLiveSessionKeySchema();

  // 更新schema版本
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// 旧版复盘表只以 account+roomId 为主键，同一直播间再次开播会覆盖上一场。
// SQLite 不能 ALTER PRIMARY KEY，因此用单事务重建；旧子表通过旧 sessions 表补 start_time。
function ensureLiveSessionKeySchema(targetDb = db) {
  const info = targetDb.prepare("PRAGMA table_info('live_sessions')").all();
  const pk = info.filter(col => col.pk > 0).sort((a, b) => a.pk - b.pk).map(col => col.name);
  if (pk.join('|') === 'account_id|room_id|start_time') return;

  targetDb.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE live_sessions RENAME TO live_sessions_v2_legacy;
    ALTER TABLE live_session_trend RENAME TO live_session_trend_v2_legacy;
    ALTER TABLE live_session_actions RENAME TO live_session_actions_v2_legacy;

    CREATE TABLE live_sessions (
      account_id TEXT NOT NULL, room_id TEXT NOT NULL, room_name TEXT,
      start_time TEXT NOT NULL DEFAULT '', end_time TEXT, status TEXT,
      cost REAL DEFAULT 0, gmv REAL DEFAULT 0, net_gmv REAL DEFAULT 0,
      orders INTEGER DEFAULT 0, source TEXT, fetched_at TEXT,
      PRIMARY KEY (account_id, room_id, start_time)
    );
    CREATE TABLE live_session_trend (
      account_id TEXT NOT NULL, room_id TEXT NOT NULL, start_time TEXT NOT NULL DEFAULT '',
      point_time TEXT NOT NULL, cost REAL DEFAULT 0, orders INTEGER DEFAULT 0,
      gmv REAL DEFAULT 0, net_1h REAL DEFAULT 0, cost_all REAL DEFAULT 0,
      PRIMARY KEY (account_id, room_id, start_time, point_time)
    );
    CREATE TABLE live_session_actions (
      account_id TEXT NOT NULL, room_id TEXT NOT NULL, start_time TEXT NOT NULL DEFAULT '',
      action_ts INTEGER NOT NULL, action_type TEXT NOT NULL DEFAULT '', action_text TEXT, kind TEXT,
      PRIMARY KEY (account_id, room_id, start_time, action_ts, action_type)
    );

    INSERT OR REPLACE INTO live_sessions
      (account_id, room_id, room_name, start_time, end_time, status, cost, gmv, net_gmv, orders, source, fetched_at)
    SELECT account_id, room_id, room_name, COALESCE(start_time, ''), end_time, status,
           cost, gmv, net_gmv, orders, source, fetched_at
    FROM live_sessions_v2_legacy;

    INSERT OR REPLACE INTO live_session_trend
      (account_id, room_id, start_time, point_time, cost, orders, gmv, net_1h, cost_all)
    SELECT t.account_id, t.room_id, COALESCE(s.start_time, ''), t.point_time,
           t.cost, t.orders, t.gmv, t.net_1h, t.cost_all
    FROM live_session_trend_v2_legacy t
    LEFT JOIN live_sessions_v2_legacy s
      ON s.account_id = t.account_id AND s.room_id = t.room_id;

    INSERT OR REPLACE INTO live_session_actions
      (account_id, room_id, start_time, action_ts, action_type, action_text, kind)
    SELECT a.account_id, a.room_id, COALESCE(s.start_time, ''), a.action_ts,
           a.action_type, a.action_text, a.kind
    FROM live_session_actions_v2_legacy a
    LEFT JOIN live_sessions_v2_legacy s
      ON s.account_id = a.account_id AND s.room_id = a.room_id;

    DROP TABLE live_sessions_v2_legacy;
    DROP TABLE live_session_trend_v2_legacy;
    DROP TABLE live_session_actions_v2_legacy;
    CREATE INDEX IF NOT EXISTS idx_live_sessions_start ON live_sessions(account_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_live_trend_time ON live_session_trend(account_id, start_time, point_time);
    COMMIT;
  `);
}

// 旧库迁移：把主键从 (material_id, stat_date) 升级为 (account_id, material_id, stat_date)。
// 通过新建表 → 拷贝 → 删旧 → 改名 的方式绕过 SQLite 不支持 ALTER PK 的限制。
function rebuildTableForAccountPK(db) {
  const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_daily'").get();
  if (!tbl || !tbl.sql) return;
  // 已纳入账号维度的主键无需重建。V6 之后可能再追加 marketing_goal；
  // 不能把这张新表误判为旧三列主键，否则会用旧 DDL 覆盖新列。
  if (/PRIMARY KEY\s*\(\s*account_id\s*,\s*material_id\s*,\s*stat_date\s*(?:,\s*marketing_goal\s*)?\)/i.test(tbl.sql)) return;
  console.log('[db] 检测到旧主键 (material_id, stat_date)，重建 material_daily 以纳入 account_id');
  try {
    db.exec('BEGIN');
    db.exec(`
    CREATE TABLE material_daily_new (
      account_id    TEXT NOT NULL DEFAULT '',
      material_id   TEXT NOT NULL,
      stat_date     TEXT NOT NULL,
      material_name TEXT,
      material_type TEXT,
      duration      TEXT,
      created_at    TEXT,
      source        TEXT,
      tags          TEXT,
      status        TEXT,
      cost          REAL DEFAULT 0,
      gmv           REAL DEFAULT 0,
      net_gmv       REAL DEFAULT 0,
      basic_cost    REAL DEFAULT 0,
      basic_gmv     REAL DEFAULT 0,
      additional_cost REAL DEFAULT 0,
      additional_gmv  REAL DEFAULT 0,
      additional_net_gmv REAL DEFAULT 0,
      additional_roi  REAL DEFAULT 0,
      orders        INTEGER DEFAULT 0,
      plays         INTEGER DEFAULT 0,
      clicks        INTEGER DEFAULT 0,
      cpc           REAL DEFAULT 0,
      finish_rate   REAL DEFAULT 0,
      rate5s        REAL DEFAULT 0,
      likes         INTEGER DEFAULT 0,
      follows       INTEGER DEFAULT 0,
      comments      INTEGER DEFAULT 0,
      cvr           REAL DEFAULT 0,
      live_cvr      REAL DEFAULT 0,
      refund_rate   REAL DEFAULT 0,
      tier          TEXT,
      role          TEXT,
      lifecycle_phase TEXT,
      settled_roi_1h REAL DEFAULT 0,
      settled_roi_7d REAL DEFAULT 0,
      avg_watch_time REAL DEFAULT 0,
      rate3s        REAL DEFAULT 0,
      settled_orders INTEGER DEFAULT 0,
      boost_refund_rate REAL DEFAULT 0,
      shows         INTEGER DEFAULT 0,
      fetched_at    TEXT,
      PRIMARY KEY (account_id, material_id, stat_date)
    );
    INSERT INTO material_daily_new (
      account_id, material_id, stat_date, material_name, material_type, duration, created_at,
      source, tags, status, cost, gmv, net_gmv, basic_cost, basic_gmv,
      additional_cost, additional_gmv, additional_net_gmv, additional_roi, orders, plays, clicks, cpc, finish_rate,
      rate5s, likes, follows, comments, cvr, live_cvr, refund_rate, tier, role, lifecycle_phase,
      settled_roi_1h, settled_roi_7d, avg_watch_time, rate3s, settled_orders, boost_refund_rate, shows, fetched_at
    )
    SELECT
      account_id, material_id, stat_date, material_name, material_type, duration, created_at,
      source, tags, status, cost, gmv, net_gmv, basic_cost, basic_gmv,
      additional_cost, additional_gmv, additional_net_gmv, additional_roi, orders, plays, clicks, cpc, finish_rate,
      rate5s, likes, follows, comments, cvr, live_cvr, refund_rate, tier, role, lifecycle_phase,
      settled_roi_1h, settled_roi_7d, avg_watch_time, rate3s, settled_orders, boost_refund_rate, shows, fetched_at
    FROM material_daily;
    DROP TABLE material_daily;
    ALTER TABLE material_daily_new RENAME TO material_daily;
    CREATE INDEX IF NOT EXISTS idx_material_daily_date ON material_daily(stat_date);
    CREATE INDEX IF NOT EXISTS idx_material_daily_material ON material_daily(material_id);
    CREATE INDEX IF NOT EXISTS idx_material_daily_account ON material_daily(account_id);
    CREATE INDEX IF NOT EXISTS idx_material_daily_composite ON material_daily(account_id, stat_date, material_id);
    `);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
    throw e;
  }
}

/**
 * 枚举 [start, end] 闭区间内的所有日期（YYYY-MM-DD）。
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
 * @returns {string[]} 日期字符串数组
 */
function eachDate(start, end) {
  const dates = [];
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

/**
 * 查询 [start, end] 范围内数据库尚未存储的日期列表。
 * 注：AIGC:: 伪素材行（回填跳过的动态创意集合）不算"已有数据"，防止其挡住真实回填。
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {string[]} 缺失的日期字符串数组
 */
function getMissingDates(start, end, accountId = defaultAccountId()) {
  const db = getDB();
  const allDates = eachDate(start, end);
  if (allDates.length === 0) return [];
  const placeholders = allDates.map(() => '?').join(',');
  // 2026-08-01 审计 P0：只按 stat_date 判存在（不分渠道）在双渠道入库后失效——
  // 历史账户专用说明已从试用包移除。
  // 本函数语义=直播渠道缺失判定，与 getMissingProductDates（mg=1）对齐各自过滤
  const stmt = db.prepare(`
    SELECT stat_date FROM material_daily
    WHERE account_id = ? AND marketing_goal = 2 AND material_id NOT LIKE 'AIGC::%' AND stat_date IN (${placeholders})
    GROUP BY stat_date
  `);
  const existing = new Set(stmt.all(accountId, ...allDates).map(r => r.stat_date));
  return allDates.filter(d => !existing.has(d));
}

// 商品卡采集起始日（mg=1 数据 2026-06-22 探针接入，此前不存在，不判缺失）
const PRODUCT_MAT_START = '2026-06-22';

/**
 * 商品卡（marketing_goal=1）缺失日期判定。
 * getMissingDates 只按 stat_date 判存在（不分渠道），"mg=2 已采但 mg=1 缺"的天判不出来
  * 历史账户专用说明已从试用包移除。
 * __EMPTY__ 空标记行带 marketing_goal=1，空日视为已采，不反复补。
 */
function getMissingProductDates(start, end, accountId = defaultAccountId()) {
  const db = getDB();
  const effStart = start < PRODUCT_MAT_START ? PRODUCT_MAT_START : start;
  const allDates = eachDate(effStart, end);
  if (allDates.length === 0) return [];
  const placeholders = allDates.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT stat_date FROM material_daily
    WHERE account_id = ? AND marketing_goal = 1 AND stat_date IN (${placeholders})
    GROUP BY stat_date
  `);
  const existing = new Set(stmt.all(accountId, ...allDates).map(r => r.stat_date));
  return allDates.filter(d => !existing.has(d));
}

function rowToDaily(row, statDate, goal = 2) {
  const cost = metricNumber(row['整体消耗(元)']);
  const gmv = metricNumber(row['整体成交金额(元)']);
  const additionalCost = metricNumber(row['追投调控消耗(元)']);
  const additionalGmv = metricNumber(row['追投调控成交金额(元)']);
  const basicCost = cost != null && additionalCost != null ? Math.max(0, cost - additionalCost) : null;
  return {
    material_id: String(row['素材ID'] || ''),
    stat_date: statDate,
    material_name: row['素材名称'] || '',
    material_type: row['视频类型'] || '',
    duration: row['视频时长'] || '',
    created_at: row['创建时间'] || '',
    source: row['来源'] || '',
    tags: row['标签'] || '',
    status: row['状态'] || '正常',
    cost,
    gmv,
    net_gmv: metricNumber(row['不含券支付金额(元)']), // legacy物理列：支付不含券
    basic_cost: basicCost,
    basic_gmv: gmv != null && additionalGmv != null ? gmv - additionalGmv : null,
    additional_cost: additionalCost,
    additional_gmv: additionalGmv,
    additional_net_gmv: metricNumber(row['追投调控1h净成交金额(元)']),
    additional_net_gmv_basis: metricNumber(row['追投调控1h净成交金额(元)']) != null ? 'platform_net_1h' : null,
    additional_roi: metricNumber(row['追投调控支付ROI']),
    orders: metricNumber(row['整体成交订单数']),
    settled_orders: metricNumber(row['净成交订单数']),
    plays: metricNumber(row['视频播放次数']),
    clicks: metricNumber(row['进房点击次数']),
    cpc: metricNumber(row['点击单价(元)']),
    finish_rate: metricNumber(row['视频完播率']),
    rate5s: metricNumber(row['5s播放占比']),
    likes: metricNumber(row['视频点赞数']),
    follows: null,  // 未选取该指标
    comments: metricNumber(row['视频评论数']),
    cvr: metricNumber(row['整体转化率']),
    live_cvr: null,  // 未选取该指标
    refund_rate: metricNumber(row['1h退款率']),
    boost_refund_rate: metricNumber(row['追投调控退款率']),
    shows: metricNumber(row['整体展现次数']),
    tier: row._stage || '',
    role: row._action || '',
    settled_roi_1h: metricNumber(row['1h结算ROI']),
    settled_roi_7d: metricNumber(row['7d结算ROI']),
    net_gmv_1h: metricNumber(row['1h结算金额'] ?? row['1h结算金额(元)']),
    marketing_goal: marketingGoal(row.marketing_goal, goal),
    avg_watch_time: metricNumber(row['视频平均观看时长(s)']),
    rate3s: metricNumber(row['3s播放占比']),
    lifecycle_phase: row._lifecycle || '',
    metric_sources_json: JSON.stringify({ version: 2, source_at: new Date().toISOString(), fields: row._metric_sources || {} }),
    fetched_at: new Date().toISOString(),
  };
}

/**
 * 存储某天某账号的素材日报数据（先删后插，事务保证原子性）。
 * @param {string} statDate - 统计日期，格式 YYYY-MM-DD
 * @param {object[]} rows - 千川 API 返回的原始行数据
  * 历史账户专用说明已从试用包移除。
 * @returns {number} 实际写入的行数（空数据返回 0）
 */
function storeDaily(statDate, rows, accountId = defaultAccountId(), goal = 2) {
  goal = marketingGoal(goal);
  const dailyRows = rows.map(r => rowToDaily(r, statDate, goal));
  if (dailyRows.some(r => r.marketing_goal !== goal)) throw new Error('marketing_goal_mismatch');
  const active = dailyRows.filter(r => r.cost > 0 || r.gmv > 0 || r.net_gmv_1h > 0
    || r.orders > 0 || r.plays > 0 || r.shows > 0 || r.additional_cost > 0);
  const db = getDB();
  const columns = ['account_id', ...Object.keys(rowToDaily({}, statDate, goal))];
  const insert = db.prepare('INSERT OR REPLACE INTO material_daily (' + columns.join(',') +
    ') VALUES (' + columns.map(() => '?').join(',') + ')');
  const existing = new Map(db.prepare('SELECT * FROM material_daily WHERE account_id=? AND stat_date=? AND marketing_goal=?')
    .all(accountId, statDate, goal).map(r => [r.material_id, r]));
  const preserve = ['plays', 'clicks', 'cpc', 'shows', 'finish_rate', 'rate3s', 'avg_watch_time'];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM material_daily WHERE account_id=? AND stat_date=? AND marketing_goal=?').run(accountId, statDate, goal);
    const toStore = active.length ? active : [rowToDaily({ '素材ID': '__EMPTY__', '整体消耗(元)': 0 }, statDate, goal)];
    for (const r of toStore) {
      const old = existing.get(r.material_id);
      const metadata = JSON.parse(r.metric_sources_json);
      let oldMeta = null;
      try { oldMeta = old && JSON.parse(old.metric_sources_json || 'null'); } catch {}
      for (const field of preserve) {
        if (r[field] == null && old && (old[field] > 0 || (oldMeta?.version === 2 && old[field] === 0))) {
          r[field] = old[field];
          metadata.fields[field] = { source: 'previous_same_day', source_at: old.fetched_at, data_valid: true };
        }
      }
      if (r.rate5s == null && oldMeta?.version === 2 && old.rate5s != null) r.rate5s = old.rate5s;
      r.metric_sources_json = JSON.stringify(metadata);
      insert.run(...columns.map(c => c === 'account_id' ? accountId : (r[c] ?? null)));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return active.length;
}

/**
 * 更新指定素材在某天的生命周期阶段标签。
 * @param {string} materialId - 素材ID
 * @param {string} statDate - 统计日期，格式 YYYY-MM-DD
 * @param {string} phase - 生命周期阶段标识
  * 历史账户专用说明已从试用包移除。
 * @returns {void}
 */
function updateLifecyclePhase(materialId, statDate, phase, accountId = defaultAccountId()) {
  const db = getDB();
  const stmt = db.prepare(`
    UPDATE material_daily SET lifecycle_phase = ?
    WHERE account_id = ? AND material_id = ? AND stat_date = ?
  `);
  stmt.run(phase, accountId, materialId, statDate);
}

/**
 * 删除指定日期列表的数据，使其可被重新采集。
 * @param {string[]} dates - 要失效的日期数组
  * 历史账户专用说明已从试用包移除。
 * @returns {number} 实际删除的行数
 */
function invalidateDates(dates, accountId = defaultAccountId()) {
  const db = getDB();
  if (!dates || dates.length === 0) return 0;
  const placeholders = dates.map(() => '?').join(',');
  const stmt = db.prepare(`DELETE FROM material_daily WHERE account_id = ? AND stat_date IN (${placeholders})`);
  const info = stmt.run(accountId, ...dates);
  return info.changes;
}

/**
 * 失效 [start, end] 闭区间内的所有日期数据。
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {number} 实际删除的行数
 */
function invalidateRange(start, end, accountId = defaultAccountId()) {
  return invalidateDates(eachDate(start, end), accountId);
}

/**
 * 按 material_id 聚合 [start, end] 范围内的素材数据，返回千川字段名格式的汇总行。
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {object[]} 聚合后的行数组（字段名为中文标签，如 '整体消耗(元)'）
 */
function aggregateRange(start, end, accountId = defaultAccountId(), goal = 2) {
  goal = marketingGoal(goal);
  const db = getDB();
  const stmt = db.prepare(`
    WITH latest AS (
      SELECT m1.material_id, m1.status
      FROM material_daily m1
      INNER JOIN (
        SELECT material_id, MAX(stat_date) AS max_date
        FROM material_daily
        WHERE account_id = ? AND marketing_goal = ${goal} AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
        GROUP BY material_id
      ) m2 ON m1.material_id = m2.material_id AND m1.stat_date = m2.max_date
      WHERE m1.account_id = ? AND m1.marketing_goal = ${goal}
    ),
    agg AS (
      SELECT
        material_id,
        MAX(material_name) AS material_name,
        MAX(material_type) AS material_type,
        MAX(duration) AS duration,
        MAX(created_at) AS created_at,
        MAX(source) AS source,
        MAX(tags) AS tags,
        ROUND(SUM(cost), 2) AS cost,
        ROUND(SUM(gmv), 2) AS gmv,
        ROUND(SUM(net_gmv), 2) AS net_gmv,
        CASE WHEN COUNT(net_gmv_1h)=COUNT(*) THEN ROUND(SUM(net_gmv_1h),2) ELSE NULL END AS net_gmv_1h,
        ROUND(SUM(basic_cost), 2) AS basic_cost,
        ROUND(SUM(basic_gmv), 2) AS basic_gmv,
        ROUND(SUM(additional_cost), 2) AS additional_cost,
        ROUND(SUM(additional_gmv), 2) AS additional_gmv,
        CASE WHEN SUM(CASE WHEN additional_cost>0 AND (additional_net_gmv_basis IS NOT 'platform_net_1h' OR additional_net_gmv IS NULL) THEN 1 ELSE 0 END)=0
          THEN ROUND(SUM(additional_net_gmv),2) ELSE NULL END AS additional_net_gmv,
        CASE WHEN SUM(additional_cost) > 0 THEN SUM(additional_gmv) / SUM(additional_cost) ELSE 0 END AS additional_roi,
        SUM(orders) AS orders,
        SUM(settled_orders) AS settled_orders,
        CASE WHEN SUM(cost) > 0 THEN SUM(gmv) / SUM(cost) ELSE 0 END AS roi,
        SUM(plays) AS plays,
        SUM(shows) AS shows,
        SUM(clicks) AS clicks,
        CASE WHEN COUNT(clicks)=COUNT(*) AND COUNT(cost)=COUNT(*) AND SUM(clicks)>0 THEN SUM(cost)/SUM(clicks) ELSE NULL END AS cpc,
        SUM(finish_rate * plays) / NULLIF(SUM(CASE WHEN finish_rate IS NOT NULL THEN plays ELSE 0 END),0) AS finish_rate,
        SUM(rate3s * plays) / NULLIF(SUM(CASE WHEN rate3s IS NOT NULL THEN plays ELSE 0 END),0) AS rate3s,
        SUM(rate5s * plays) / NULLIF(SUM(CASE WHEN rate5s IS NOT NULL THEN plays ELSE 0 END),0) AS rate5s,
        SUM(likes) AS likes,
        SUM(follows) AS follows,
        SUM(comments) AS comments,
        CASE WHEN SUM(orders) > 0 THEN SUM(cost) / SUM(orders) ELSE 0 END AS order_cost,
        CASE WHEN SUM(orders) > 0 THEN SUM(refund_rate * orders) / SUM(orders) ELSE 0 END AS refund_rate,
        CASE WHEN SUM(additional_cost) > 0 THEN SUM(boost_refund_rate * additional_cost) / SUM(additional_cost) ELSE 0 END AS boost_refund_rate,
        CASE WHEN SUM(cost) > 0 THEN SUM(settled_roi_1h * cost) / SUM(cost) ELSE 0 END AS settled_roi_1h,
        CASE WHEN SUM(cost) > 0 THEN SUM(settled_roi_7d * cost) / SUM(cost) ELSE 0 END AS settled_roi_7d,
        SUM(avg_watch_time * plays) / NULLIF(SUM(CASE WHEN avg_watch_time IS NOT NULL THEN plays ELSE 0 END),0) AS avg_watch_time,
        CASE WHEN COUNT(orders)=COUNT(*) AND COUNT(clicks)=COUNT(*) AND SUM(clicks)>0 THEN 100.0*SUM(orders)/SUM(clicks) ELSE NULL END AS cvr
      FROM material_daily
      WHERE account_id = ? AND marketing_goal = ${goal} AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
      GROUP BY material_id
    )
    SELECT agg.*, latest.status
    FROM agg
    JOIN latest ON agg.material_id = latest.material_id
  `);
  const rows = stmt.all(accountId, start, end, accountId, accountId, start, end);
  return rows.map(r => ({
    '素材ID': r.material_id,
    '素材名称': r.material_name,
    '视频类型': r.material_type,
    '视频时长': r.duration,
    '创建时间': r.created_at,
    '来源': r.source,
    '标签': r.tags,
    '状态': r.status,
    '整体消耗(元)': r.cost,
    '整体成交金额(元)': r.gmv,
    '不含券支付金额(元)': r.net_gmv,
    '净成交金额(元)': r.net_gmv_1h,
    '1h结算金额(元)': r.net_gmv_1h,
    '基础消耗(元)': r.basic_cost,
    '基础成交金额(元)': r.basic_gmv,
    '追投调控消耗(元)': r.additional_cost,
    '追投调控成交金额(元)': r.additional_gmv,
    '追投调控净成交金额(元)': r.additional_net_gmv,
    '追投净成交金额(元)': r.additional_net_gmv,  // 兼容todaySnapshot.js别名
    '追投调控支付ROI': r.additional_roi,
    '整体支付ROI': r.roi,
    '整体成交订单数': r.orders,
    '净成交订单数': r.settled_orders,
    '订单成本': r.order_cost,
    '整体展现次数': r.shows,
    '进房点击次数': r.clicks,
    '点击单价(元)': r.cpc,
    '整体转化率': r.cvr,
    '追投调控退款率': r.boost_refund_rate,
    '视频播放次数': r.plays,
    '视频完播率': r.finish_rate,
    '3s播放占比': r.rate3s,
    '5s播放占比': r.rate5s,
    marketing_goal: goal,
    roi_basis: 'platform_net_1h',
    '视频点赞数': r.likes,
    '视频评论数': r.comments,
    '1h退款率': r.refund_rate,
    '1h结算ROI': r.settled_roi_1h,
    '7d结算ROI': r.settled_roi_7d,
    '视频平均观看时长(s)': r.avg_watch_time,
  }));
}

/**
 * 查询单个素材在 [start, end] 范围内的逐日历史记录。
 * @param {string} materialId - 素材ID
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {object[]} 按日期升序排列的历史行数组
 */
function getMaterialHistory(materialId, start, end, accountId = defaultAccountId()) {
  const db = getDB();
  const stmt = db.prepare(`
    SELECT * FROM material_daily
    WHERE account_id = ? AND material_id = ? AND stat_date >= ? AND stat_date <= ?
    ORDER BY stat_date
  `);
  return stmt.all(accountId, materialId, start, end);
}

/**
 * 查询 [start, end] 范围内的数据覆盖情况（存储天数、最早/最晚日期）。
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {{days:number, min_date:string, max_date:string}} 覆盖统计
 */
function getCoverage(start, end, accountId = defaultAccountId()) {
  const db = getDB();
  const stmt = db.prepare(`
    SELECT COUNT(DISTINCT stat_date) AS days,
           MIN(stat_date) AS min_date,
           MAX(stat_date) AS max_date
    FROM material_daily
    WHERE account_id = ? AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
  `);
  return stmt.get(accountId, start, end);
}

/**
 * 查询 [start, end] 范围内所有素材的逐日明细（排除 __EMPTY__ 占位行）。
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {object[]} 按 material_id, stat_date 排序的行数组
 */
function getRangeHistory(start, end, accountId = defaultAccountId()) {
  const db = getDB();
  const stmt = db.prepare(`
    SELECT * FROM material_daily
    WHERE account_id = ? AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
    ORDER BY material_id, stat_date
  `);
  return stmt.all(accountId, start, end);
}

/**
 * 将扁平的行数组按 material_id 分组成字典。
 * @param {object[]} rows - 数据库查询返回的行数组
 * @returns {Object<string, object[]>} key 为 material_id，value 为该素材的行数组
 */
function groupHistoryByMaterial(rows) {
  const map = {};
  for (const r of rows) {
    if (!map[r.material_id]) map[r.material_id] = [];
    map[r.material_id].push(r);
  }
  return map;
}

/**
 * 计算今日基线：过去 30 天（截止昨日）的聚合数据 + 逐素材历史。
 * @param {string} todayStr - 今日日期，格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {{aggregates:object[], histories:Object<string,object[]>, yesterday:string, start30:string}} 基线数据
 */
function getBaselineForToday(todayStr, accountId = defaultAccountId()) {
  const today = new Date(todayStr + 'T00:00:00');
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const start30 = new Date(today);
  start30.setDate(start30.getDate() - 30);

  const yStr = formatDate(yesterday);
  const s30Str = formatDate(start30);

  const aggregates = aggregateRange(s30Str, yStr, accountId);
  const historyRows = getRangeHistory(s30Str, yStr, accountId);
  const histories = groupHistoryByMaterial(historyRows);
  return { aggregates, histories, yesterday: yStr, start30: s30Str };
}

/**
 * 按天聚合 [start, end] 范围内的数据，返回每日汇总（供 sparkline 趋势图使用）。
 * @param {string} start - 起始日期（含），格式 YYYY-MM-DD
 * @param {string} end - 结束日期（含），格式 YYYY-MM-DD
  * 历史账户专用说明已从试用包移除。
 * @returns {object[]} 每日汇总行数组（含 stat_date, cost, gmv, orders 等）
 */
function aggregateByDate(start, end, accountId = defaultAccountId()) {
  const db = getDB();
  const stmt = db.prepare(`
    SELECT
      stat_date,
      ROUND(SUM(cost), 2) AS cost,
      ROUND(SUM(gmv), 2) AS gmv,
      ROUND(SUM(net_gmv), 2) AS net_gmv,
      ROUND(SUM(net_gmv_1h), 2) AS net_gmv_1h,
      SUM(orders) AS orders,
      COUNT(DISTINCT material_id) AS material_count
    FROM material_daily
    WHERE account_id = ? AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
    GROUP BY stat_date
    ORDER BY stat_date
  `);
  return stmt.all(accountId, start, end);
}

/**
 * 清除指定日期范围内的 __EMPTY__ 空标记行，使这些日期能被回填任务重新查询。
 * 用于解决"cookie失效/限流时返回空结果被标记为永久无数据"的问题。
 */
function clearEmptyMarkers(start, end, accountId = defaultAccountId()) {
  const db = getDB();
  db.prepare(`DELETE FROM material_daily WHERE material_id = '__EMPTY__' AND account_id = ? AND stat_date >= ? AND stat_date <= ?`)
    .run(accountId, start, end);
}

// ═══════════════════════════════════════════════════════════
// 素材深度数据存储函数
// ═══════════════════════════════════════════════════════════

function storeInsight(accountId, materialId, statDate, insight) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO material_insight (account_id, material_id, stat_date, total_seconds, lose_rate_5s, click_count, drop_count, seconds_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(accountId, materialId, statDate, insight.totalSeconds, insight.loseRate5s, insight.clickCount || 0, insight.dropCount || 0, JSON.stringify(insight.seconds), new Date().toISOString());
}

function storeCrowd(accountId, materialId, statDate, crowd) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO material_crowd (account_id, material_id, stat_date, crowd_json, fetched_at)
    VALUES (?, ?, ?, ?, ?)`).run(accountId, materialId, statDate, JSON.stringify(crowd), new Date().toISOString());
}

function storeBoostTasks(accountId, materialId, statDate, tasks) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO material_boost_task (account_id, material_id, stat_date, tasks_json, fetched_at)
    VALUES (?, ?, ?, ?, ?)`).run(accountId, materialId, statDate, JSON.stringify(tasks), new Date().toISOString());
}

function storeContent(accountId, materialId, statDate, script, creative) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO material_content (account_id, material_id, stat_date, script_json, creative_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(accountId, materialId, statDate, script ? JSON.stringify(script) : null, creative ? JSON.stringify(creative) : null, new Date().toISOString());
}

function getInsight(accountId, materialId, statDate) {
  const db = getDB();
  return db.prepare('SELECT * FROM material_insight WHERE account_id=? AND material_id=? AND stat_date=?').get(accountId, materialId, statDate);
}

/**
 * 仅更新 material_insight 的 click_count / drop_count（用于千川实时 detail 反写本地缓存，
 * 让下次 profile 快路径能直接读到准确的整体点击/流失次数）。
 */
function updateInsightClickDrop(accountId, materialId, clickCount, dropCount) {
  const db = getDB();
  const row = db.prepare('SELECT stat_date FROM material_insight WHERE account_id=? AND material_id=? ORDER BY stat_date DESC LIMIT 1').get(accountId, materialId);
  if (!row) return;
  db.prepare('UPDATE material_insight SET click_count=?, drop_count=? WHERE account_id=? AND material_id=? AND stat_date=?')
    .run(clickCount || 0, dropCount || 0, accountId, materialId, row.stat_date);
}

function getCrowd(accountId, materialId, statDate) {
  const db = getDB();
  return db.prepare('SELECT * FROM material_crowd WHERE account_id=? AND material_id=? AND stat_date=?').get(accountId, materialId, statDate);
}

function getBoostTasks(accountId, materialId, statDate) {
  const db = getDB();
  return db.prepare('SELECT * FROM material_boost_task WHERE account_id=? AND material_id=? AND stat_date=?').get(accountId, materialId, statDate);
}

function getContent(accountId, materialId, statDate) {
  const db = getDB();
  return db.prepare('SELECT * FROM material_content WHERE account_id=? AND material_id=? AND stat_date=?').get(accountId, materialId, statDate);
}

// ═══════════════════════════════════════════════════════════
// MHS 特征快照存取（material_features）
// ═══════════════════════════════════════════════════════════

/**
 * 写入单素材某日特征快照（INSERT OR REPLACE，幂等）。
 * @param {string} accountId
 * @param {string} materialId
 * @param {string} statDate - 特征基准日 YYYY-MM-DD（数据截止日）
 * @param {object} f - 特征对象（lib/mhs.js computeFeatures/computeMhs 的产出）
 */
function storeFeatures(accountId, materialId, statDate, f) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO material_features
    (account_id, material_id, stat_date, age_days, role, decay_weighted_roi, cost_momentum, roi_momentum,
     ctr, ctr_rel, retention_5s, boost_response, cost_share_7d, gmv_share_7d,
     benefit_score, trend_score, potential_score, age_decay, mhs, tier, params_version, features_json, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(accountId, materialId, statDate,
      f.age_days ?? null, f.role ?? null, f.decay_weighted_roi ?? null, f.cost_momentum ?? null, f.roi_momentum ?? null,
      f.ctr ?? null, f.ctr_rel ?? null, f.retention_5s ?? null, f.boost_response ?? null, f.cost_share_7d ?? null, f.gmv_share_7d ?? null,
      f.benefit_score ?? null, f.trend_score ?? null, f.potential_score ?? null, f.age_decay ?? null,
      f.mhs ?? null, f.tier ?? null, f.params_version ?? null,
      JSON.stringify(f), new Date().toISOString());
}

/** 读取某账号某日全部素材特征快照（按 mhs 降序，未标定的排最后） */
function getFeaturesByDate(accountId, statDate) {
  const db = getDB();
  return db.prepare(`SELECT * FROM material_features WHERE account_id=? AND stat_date=? ORDER BY mhs IS NULL, mhs DESC`)
    .all(accountId, statDate);
}

/** 读取单素材最近 N 天的特征快照（升序） */
function getFeatureHistory(accountId, materialId, days = 30) {
  const db = getDB();
  return db.prepare(`SELECT * FROM material_features WHERE account_id=? AND material_id=? ORDER BY stat_date DESC LIMIT ?`)
    .all(accountId, materialId, days).reverse();
}

module.exports = {
  getDB,
  initSchema,
  eachDate,
  getMissingDates,
  getMissingProductDates,
  storeDaily,
  updateLifecyclePhase,
  invalidateDates,
  invalidateRange,
  aggregateRange,
  aggregateByDate,
  getMaterialHistory,
  getCoverage,
  getRangeHistory,
  groupHistoryByMaterial,
  getBaselineForToday,
  clearEmptyMarkers,
  storeInsight,
  updateInsightClickDrop,
  storeCrowd,
  storeBoostTasks,
  storeContent,
  getInsight,
  getCrowd,
  getBoostTasks,
  getContent,
  storeFeatures,
  getFeaturesByDate,
  getFeatureHistory,
  _test: { ensureLiveSessionKeySchema },
};
