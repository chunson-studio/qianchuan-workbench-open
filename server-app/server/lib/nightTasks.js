

const fs = require('fs');
const path = require('path');
const { formatDate, num } = require('./utils');
const { aggregateRange, getDB } = require('./db');
const opLog = require('./operationLog');
const { manual_config, CLASSIFICATION } = require('./config');

const MEMORY_DIR = path.join(__dirname, '..', '..', 'agent-memory');
const REPORTS_DIR = path.join(MEMORY_DIR, 'reports');
const LESSONS_DIR = path.join(MEMORY_DIR, 'lessons');
const DECISIONS_DIR = path.join(MEMORY_DIR, 'decisions');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const DB_PATH = path.join(__dirname, '..', '..', 'cache', 'material_history.db');

[REPORTS_DIR, LESSONS_DIR, DECISIONS_DIR, BACKUP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});


const BACKUP_STATE_FILE = path.join(__dirname, '..', '..', 'cache', 'backup_state.json');

function writeBackupState(state) {
  try {
    const tmp = BACKUP_STATE_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, BACKUP_STATE_FILE);
  } catch (e) {
    console.error('[night-task] 写 backup_state.json 失败:', e.message);
  }
}

function backupDatabase() {
  const date = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000)); 
  const backupFile = path.join(BACKUP_DIR, `material_history_${date}.db`);

  try {
    
    if (fs.existsSync(backupFile)) {
      console.log(`[night-task] 数据库备份已存在: ${backupFile}`);
      writeBackupState({ last_success_at: new Date().toISOString(), last_fail_at: null, last_error: null });
      return;
    }

    
    if (!backupFile.startsWith(BACKUP_DIR) || !/^material_history_\d{4}-\d{2}-\d{2}\.db$/.test(path.basename(backupFile))) {
      throw new Error('备份路径非法: ' + backupFile);
    }

    
    const db = getDB();
    db.exec(`VACUUM INTO '${backupFile.replace(/\\/g, '/')}'`);
    const size = fs.statSync(backupFile).size;
    console.log(`[night-task] 数据库已备份: ${path.basename(backupFile)} (${(size / 1024).toFixed(0)}KB)`);
    writeBackupState({ last_success_at: new Date().toISOString(), last_fail_at: null, last_error: null });

    
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('material_history_') && f.endsWith('.db'))
      .sort()
      .reverse();
    if (backups.length > 7) {
      for (const old of backups.slice(7)) {
        fs.unlinkSync(path.join(BACKUP_DIR, old));
        console.log(`[night-task] 清理旧备份: ${old}`);
      }
    }
  } catch (e) {
    console.error(`[night-task] 数据库备份失败:`, e.message);
    writeBackupState({ last_success_at: null, last_fail_at: new Date().toISOString(), last_error: e.message });
  }
}


function generateDailyReport(date, accountId, accountName) {
  try {
    const agg = aggregateRange(date, date, accountId);
    const totalCost = agg.reduce((s, r) => s + num(r['整体消耗(元)']), 0);
    const totalGmv = agg.reduce((s, r) => s + num(r['整体成交金额(元)']), 0);
    const totalNetGmv = agg.reduce((s, r) => s + num(r['净成交金额(元)']), 0);
    const totalOrders = agg.reduce((s, r) => s + num(r['整体成交订单数']), 0);
    const totalPlays = agg.reduce((s, r) => s + num(r['视频播放次数']), 0);
    const totalBoostCost = agg.reduce((s, r) => s + num(r['追投调控消耗(元)']), 0);
    const totalBoostGmv = agg.reduce((s, r) => s + num(r['追投调控净成交金额(元)']), 0);

    const roi = totalCost > 0 ? totalGmv / totalCost : 0;
    const netRoi = totalCost > 0 ? totalNetGmv / totalCost : 0;
    const boostRoi = totalBoostCost > 0 ? totalBoostGmv / totalBoostCost : 0;
    const orderCost = totalOrders > 0 ? totalCost / totalOrders : 0;

    
    const logs = opLog.query({ startDate: date, endDate: date, accountId, limit: 100 });
    const successOps = logs.filter(l => l.success).length;
    const failOps = logs.filter(l => !l.success).length;

    
    const topMaterials = agg
      .filter(r => num(r['整体消耗(元)']) > 0)
      .sort((a, b) => num(b['整体消耗(元)']) - num(a['整体消耗(元)']))
      .slice(0, 10)
      .map(r => ({
        id: r['素材ID'],
        name: r['素材名称'],
        cost: num(r['整体消耗(元)']),
        gmv: num(r['整体成交金额(元)']),
        roi: num(r['整体支付ROI']),
        orders: num(r['整体成交订单数']),
        status: r['状态'],
      }));

    
    const topBoost = agg
      .filter(r => num(r['追投调控消耗(元)']) > 0)
      .sort((a, b) => num(b['追投调控消耗(元)']) - num(a['追投调控消耗(元)']))
      .slice(0, 5)
      .map(r => ({
        id: r['素材ID'],
        name: r['素材名称'],
        boostCost: num(r['追投调控消耗(元)']),
        boostGmv: num(r['追投调控净成交金额(元)']),
        boostRoi: num(r['追投调控支付ROI']),
      }));

    const report = {
      date,
      account_id: accountId,
      account_name: accountName,
      generated_at: new Date().toISOString(),
      generated_by: 'night_task',
      summary: {
        cost: Math.round(totalCost * 100) / 100,
        gmv: Math.round(totalGmv * 100) / 100,
        net_gmv: Math.round(totalNetGmv * 100) / 100,
        roi: Math.round(roi * 100) / 100,
        net_roi: Math.round(netRoi * 100) / 100,
        orders: totalOrders,
        plays: totalPlays,
        order_cost: Math.round(orderCost * 100) / 100,
        boost_cost: Math.round(totalBoostCost * 100) / 100,
        boost_gmv: Math.round(totalBoostGmv * 100) / 100,
        boost_roi: Math.round(boostRoi * 100) / 100,
        material_count: agg.filter(r => num(r['整体消耗(元)']) > 0).length,
      },
      operations: {
        total: logs.length,
        success: successOps,
        fail: failOps,
        details: logs.slice(0, 20).map(l => ({
          time: l.ts,
          action: l.action,
          success: l.success,
          result_msg: l.result_msg,
        })),
      },
      top_materials: topMaterials,
      top_boost: topBoost,
    };

    const fileName = `daily_${accountId}_${date}.json`;
    fs.writeFileSync(path.join(REPORTS_DIR, fileName), JSON.stringify(report, null, 2), 'utf8');
    console.log(`[night-task] 日报已生成: ${fileName}`);
    return report;
  } catch (e) {
    console.error(`[night-task] 日报生成失败 ${accountId} ${date}:`, e.message);
    return null;
  }
}


function generateDailyReview() { return {available:false,code:'private_strategy_not_included'}; }


async function runNightTasks(accounts) {
  const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  console.log(`[night-task] 开始执行夜间任务，目标日期: ${yesterday}`);

  
  backupDatabase();

  
  
  for (const acc of accounts) {
    try {
      const { reconcileDate } = require('./reconcile');
      await reconcileDate(yesterday, acc.id);
    } catch (e) {
      console.error(`[night-task] ${acc.id} 对账执行失败:`, e.message);
    }
  }

  
  try {
    const { spawnSync } = require('child_process');
    const script = path.join(__dirname, '..', '..', 'scripts', 'intraday_reconcile.js');
    const r = spawnSync(process.execPath, [script], { timeout: 60000, encoding: 'utf8' });
    if (r.status !== 0) console.error(`[night-task] 盘中对账失败: ${(r.stderr || '').slice(0, 200)}`);
    else console.log((r.stdout || '').trim().split('\n')[0]);
  } catch (e) {
    console.error('[night-task] 盘中对账执行异常:', e.message);
  }
  try {
    const { prune } = require('./intradayStore');
    const n = prune(7);
    console.log(`[night-task] 盘中库 prune 清理 ${n} 行（保留近 7 天）`);
  } catch (e) {
    console.error('[night-task] 盘中库 prune 失败:', e.message);
  }

  

  
  try {
    const { refreshDeepData } = require('./fetchDaily');
    await refreshDeepData(yesterday, accounts);
  } catch (e) {
    console.error('[night-task] 深度数据刷新总调度失败:', e.message);
  }

  
  
  for (const acc of accounts) {
    try {
      const { auditMaterialScripts } = require('./materialScriptCoverage');
      const coverage = await auditMaterialScripts({
        accountId: acc.id,
        date: yesterday,
        repair: true,
        limit: 30,
      });
      console.log(`[night-task] 素材文案 ${acc.id} @${yesterday}: ${coverage.available_scripts}/${coverage.total_materials}（缺${coverage.missing_scripts}，本轮补${coverage.repaired_count}）`);
    } catch (e) {
      console.error(`[night-task] 素材文案检查失败 ${acc.id}:`, e.message);
    }
  }

  
  for (const acc of accounts) {
    try {
      const { syncAccountDay } = require('./liveSessionStore');
      const r = await syncAccountDay(acc.id, yesterday);
      console.log(`[night-task] 场次入库 ${acc.id} @${yesterday}: ${r.sessions} 场 / trend ${r.trend} 点 / actions ${r.actions} 条${r.errors.length ? ' / 异常 ' + r.errors.length : ''}`);
    } catch (e) {
      console.error(`[night-task] 场次入库失败 ${acc.id}:`, e.message);
    }
  }

  
  const reports = [];
  for (const acc of accounts) {
    const report = generateDailyReport(yesterday, acc.id, acc.name);
    if (report) reports.push(report);
  }

  
  generateDailyReview(yesterday, reports);

  
  generateInsightInputs(accounts);

  console.log(`[night-task] 夜间任务完成`);
}


function generateInsightInputs() { return {available:false,code:'private_strategy_not_included'}; }














module.exports = { runNightTasks, backupDatabase, generateInsightInputs };
