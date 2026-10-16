'use strict';

const fs = require('fs');
const path = require('path');
const { CACHE_DIR } = require('./config');
const { getDB, storeContent } = require('./db');
const { fetchCreativeAnalysis, fetchScript } = require('./data');
const creativeVideoLibrary = require('./creativeVideoLibrary');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function scriptTextFromJson(scriptJson) {
  if (scriptJson == null) return '';
  try {
    const parsed = typeof scriptJson === 'string' ? JSON.parse(scriptJson) : scriptJson;
    if (typeof parsed === 'string') return parsed.trim();
    if (parsed && typeof parsed.text === 'string') return parsed.text.trim();
    if (parsed && parsed.data && typeof parsed.data.text === 'string') return parsed.data.text.trim();
  } catch {
    return '';
  }
  return '';
}

function isRealMaterialId(value) {
  return /^\d{11,}$/.test(String(value || ''));
}

function queryDailyMaterials(db, accountId, date) {
  return db.prepare(`
    SELECT material_id,
           MAX(material_name) AS material_name,
           ROUND(SUM(COALESCE(cost, 0)), 2) AS cost,
           MAX(status) AS status
    FROM material_daily
    WHERE account_id = ? AND stat_date = ?
      AND material_id IS NOT NULL
      AND material_id NOT IN ('__EMPTY__', '-', '-2')
    GROUP BY material_id
    ORDER BY cost DESC, material_id
  `).all(accountId, date).filter(row => isRealMaterialId(row.material_id));
}

function queryContentRows(db, accountId, materialIds) {
  if (!materialIds.length) return [];
  const placeholders = materialIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT material_id, stat_date, script_json, creative_json, fetched_at
    FROM material_content
    WHERE account_id = ? AND material_id IN (${placeholders})
    ORDER BY material_id, stat_date DESC, fetched_at DESC
  `).all(accountId, ...materialIds);
}

function mergeMaterials(dailyMaterials, uploadedMaterials) {
  const merged = new Map();
  for (const item of dailyMaterials || []) {
    const id = String(item.material_id);
    merged.set(id, { ...item, material_id: id, material_sources: ['daily_delivery'] });
  }
  for (const item of uploadedMaterials || []) {
    const id = String(item.material_id);
    if (!isRealMaterialId(id)) continue;
    const existing = merged.get(id);
    if (existing) {
      existing.material_name = existing.material_name || item.material_name || item.name || null;
      existing.material_sources = Array.from(new Set([...existing.material_sources, 'new_upload']));
    } else {
      merged.set(id, {
        material_id: id,
        material_name: item.material_name || item.name || null,
        cost: Number(item.cost || 0),
        status: item.status || null,
        material_sources: ['new_upload'],
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => Number(b.cost || 0) - Number(a.cost || 0));
}

async function discoverUploadsForDate(accountId, date, fetchPage = creativeVideoLibrary.fetchPage) {
  const uploads = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 5) {
    const batch = await fetchPage(accountId, { page, pageSize: 100 });
    const videos = Array.isArray(batch && batch.videos) ? batch.videos : [];
    for (const video of videos) {
      if (String(video.create_time || '').slice(0, 10) === date && isRealMaterialId(video.material_id)) {
        uploads.push({
          material_id: String(video.material_id),
          material_name: video.name || null,
          cost: Number(video.cost || 0),
          status: video.delivery_status == null ? null : String(video.delivery_status),
        });
      }
    }
    const oldestDate = videos.length ? String(videos[videos.length - 1].create_time || '').slice(0, 10) : '';
    hasMore = Boolean(batch && batch.hasMore) && Boolean(oldestDate) && oldestDate >= date;
    page++;
  }
  return uploads;
}

function inspectMaterialScripts({ db, accountId, date, materials: suppliedMaterials }) {
  if (!accountId) throw new Error('account_id_required');
  if (!DATE_RE.test(String(date || ''))) throw new Error('invalid_date');

  const materials = suppliedMaterials || queryDailyMaterials(db, accountId, date);
  const contentRows = queryContentRows(db, accountId, materials.map(row => String(row.material_id)));
  const byMaterial = new Map();
  for (const row of contentRows) {
    const id = String(row.material_id);
    if (!byMaterial.has(id)) byMaterial.set(id, []);
    byMaterial.get(id).push(row);
  }

  const items = materials.map(material => {
    const materialId = String(material.material_id);
    const rows = byMaterial.get(materialId) || [];
    const validRow = rows.find(row => scriptTextFromJson(row.script_json).length > 0);
    const hasCreative = rows.some(row => row.creative_json != null);
    let scriptStatus = 'available';
    if (!validRow) scriptStatus = rows.length === 0 ? 'content_not_fetched' : 'script_missing';
    return {
      material_id: materialId,
      material_name: material.material_name || null,
      cost: Number(material.cost || 0),
      delivery_status: material.status || null,
      material_sources: material.material_sources || ['daily_delivery'],
      script_status: scriptStatus,
      script_source_date: validRow ? validRow.stat_date : null,
      has_creative_metadata: hasCreative,
    };
  });

  const available = items.filter(item => item.script_status === 'available');
  const missing = items.filter(item => item.script_status !== 'available');
  return {
    account_id: accountId,
    date,
    generated_at: new Date().toISOString(),
    total_materials: items.length,
    available_scripts: available.length,
    missing_scripts: missing.length,
    coverage_pct: items.length ? Math.round((available.length / items.length) * 10000) / 100 : null,
    status: items.length ? (missing.length ? 'incomplete' : 'complete') : 'no_materials',
    complete: items.length ? missing.length === 0 : null,
    items,
    missing,
  };
}

function safeAccountFilePart(accountId) {
  return String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function persistCoverageReport(report, cacheDir = CACHE_DIR) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `material_script_coverage_${safeAccountFilePart(report.account_id)}.json`);
  const temp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return target;
}

async function auditMaterialScripts(options) {
  const {
    accountId,
    date,
    repair = false,
    limit = 30,
    persist = true,
    db = getDB(),
    fetchCreative = fetchCreativeAnalysis,
    fetchMaterialScript = fetchScript,
    fetchRawMaterial = creativeVideoLibrary.fetchRawByMaterialId,
    discoverUploads = true,
    fetchVideoLibraryPage = creativeVideoLibrary.fetchPage,
    saveContent = storeContent,
    cacheDir = CACHE_DIR,
  } = options || {};

  let discoveryError = null;
  let uploadedMaterials = [];
  if (discoverUploads) {
    try {
      uploadedMaterials = await discoverUploadsForDate(accountId, date, fetchVideoLibraryPage);
    } catch (error) {
      discoveryError = error && error.message ? error.message : String(error);
    }
  }
  const materials = mergeMaterials(queryDailyMaterials(db, accountId, date), uploadedMaterials);
  const before = inspectMaterialScripts({ db, accountId, date, materials });
  const repairs = [];
  if (repair && before.missing.length) {
    const candidates = limit > 0 ? before.missing.slice(0, limit) : before.missing;
    for (const item of candidates) {
      const result = { material_id: item.material_id, material_name: item.material_name, repaired: false };
      try {
        const creative = await fetchCreative(item.material_id, accountId);
        let scriptUri = creative && creative.materialUri;
        if (!scriptUri && fetchRawMaterial) {
          const rawMaterial = await fetchRawMaterial(accountId, item.material_id);
          scriptUri = rawMaterial && (
            (rawMaterial.videoUrl && rawMaterial.videoUrl.uri) || rawMaterial.itemId
          );
          if (scriptUri) {
            result.uri_source = rawMaterial.videoUrl && rawMaterial.videoUrl.uri
              ? 'video_library_uri'
              : 'video_library_item_id';
          }
        }
        if (!scriptUri) {
          result.code = 'material_uri_missing';
          repairs.push(result);
          continue;
        }
        const script = await fetchMaterialScript(scriptUri, accountId);
        if (!script || !String(script.text || '').trim()) {
          result.code = 'script_unavailable';
          repairs.push(result);
          continue;
        }
        saveContent(accountId, item.material_id, date, script, creative);
        result.repaired = true;
        result.code = 'repaired';
      } catch (error) {
        result.code = error && error.code ? error.code : 'repair_failed';
        result.error = error && error.message ? error.message : String(error);
      }
      repairs.push(result);
    }
  }

  const after = inspectMaterialScripts({ db, accountId, date, materials });
  const report = {
    ...after,
    discovery: {
      daily_delivery_materials: queryDailyMaterials(db, accountId, date).length,
      new_upload_materials: uploadedMaterials.length,
      video_library_ok: discoverUploads ? discoveryError == null : null,
      error: discoveryError,
    },
    repair_requested: Boolean(repair),
    repair_limit: limit,
    before_missing_scripts: before.missing_scripts,
    repaired_count: repairs.filter(item => item.repaired).length,
    repair_results: repairs,
  };
  if (persist) report.report_file = persistCoverageReport(report, cacheDir);
  return report;
}

module.exports = {
  auditMaterialScripts,
  discoverUploadsForDate,
  inspectMaterialScripts,
  mergeMaterials,
  persistCoverageReport,
  scriptTextFromJson,
  _test: { isRealMaterialId, queryDailyMaterials },
};
