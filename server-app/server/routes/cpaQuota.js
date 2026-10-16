const fs = require('fs');
const path = require('path');
const { sendJSON } = require('../lib/utils');

async function handleCpaQuota(req, res, url) {
  if (req.method !== 'GET') {
    return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  }

  let port = 8317;
  let apiKey = '123456';

  // Parse port and key from config.yaml dynamically
  // 路径基于 USERPROFILE/HOME 动态解析，避免绑定开发机。
  try {
    const yamlPath = path.join(process.env.USERPROFILE || process.env.HOME || '', 'CLIProxyAPI', 'config.yaml');
    if (fs.existsSync(yamlPath)) {
      const yaml = fs.readFileSync(yamlPath, 'utf8');
      const portMatch = yaml.match(/^port:\s*(\d+)/m);
      if (portMatch) port = parseInt(portMatch[1], 10);
      
      const keysMatch = yaml.match(/api-keys:\r?\n\s*-\s*['"]?([^'"\r\n]+)['"]?/);
      if (keysMatch) apiKey = keysMatch[1];
    }
  } catch (e) {
    // fallback
  }

  try {
    const cpaRes = await fetch(`http://127.0.0.1:${port}/v0/management/auth-files`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (cpaRes.status !== 200) {
      return sendJSON(res, { ok: false, error: `CPA Management API returned HTTP ${cpaRes.status}` }, 502);
    }

    const data = await cpaRes.json();
    const accounts = (data.files || []).map(f => {
      const recent5h = (f.recent_requests || []).slice(-30);
      const sumSuccess5h = recent5h.reduce((s, r) => s + r.success, 0);
      const sumFailed5h = recent5h.reduce((s, r) => s + r.failed, 0);
      const total5h = sumSuccess5h + sumFailed5h;

      const limit5h = 45;
      const remaining = Math.max(0, limit5h - total5h);
      const pct = Math.round((remaining / limit5h) * 100);

      const firstActive = recent5h.find(r => r.success > 0 || r.failed > 0);
      let forecastRelease = null;
      if (firstActive) {
        forecastRelease = {
          time_window: firstActive.time,
          amount: firstActive.success + firstActive.failed
        };
      }

      return {
        email: f.email,
        provider: f.provider,
        status: f.status,
        unavailable: f.unavailable,
        success_total: f.success,
        failed_total: f.failed,
        usage_5h: {
          total: total5h,
          success: sumSuccess5h,
          failed: sumFailed5h,
          estimated_remaining: remaining,
          percentage: pct
        },
        forecast_release: forecastRelease,
        recent_timeline: (f.recent_requests || []).slice(-12).map(r => ({
          time: r.time,
          success: r.success,
          failed: r.failed
        }))
      };
    });

    return sendJSON(res, {
      ok: true,
      total_accounts: accounts.length,
      accounts,
      server_time: new Date().toISOString()
    });
  } catch (e) {
    return sendJSON(res, { ok: false, error: `无法连接到本地 CPA 服务: ${e.message}` }, 500);
  }
}

module.exports = handleCpaQuota;
