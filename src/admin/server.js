const fs = require('fs');
const path = require('path');
const express = require('express');
const { execSync } = require('child_process');

function nowIso() { return new Date().toISOString(); }


function safeInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function normalizeTargetEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(.+):(\d+)$/);
    if (!match) return null;
    const port = safeInt(match[2], null);
    if (!port || port < 1 || port > 65535) return null;
    return { ip: match[1].trim(), port };
  }
  if (typeof entry !== 'object') return null;
  const ip = (entry.ip || entry.host || '').toString().trim();
  const port = safeInt(entry.port, null);
  if (!ip || !port || port < 1 || port > 65535) return null;
  return { ip, port };
}

function normalizeTargetList(body) {
  if (Array.isArray(body?.targets)) {
    return body.targets.map(normalizeTargetEntry).filter(Boolean);
  }
  const legacy = normalizeTargetEntry({ ip: body?.ip, port: body?.port });
  return legacy ? [legacy] : [];
}

async function findNewestLogFile(dir, prefix) {
  try {
    const files = await fs.promises.readdir(dir);
    const matches = files
      .filter(f => f.startsWith(prefix + '-') && f.endsWith('.log'))
      .map(f => path.join(dir, f));
    if (matches.length === 0) return null;
    let newest = matches[0];
    let newestM = (await fs.promises.stat(newest)).mtimeMs;
    for (let i = 1; i < matches.length; i += 1) {
      const st = await fs.promises.stat(matches[i]);
      if (st.mtimeMs > newestM) { newestM = st.mtimeMs; newest = matches[i]; }
    }
    return newest;
  } catch (_) { return null; }
}

async function tailFile(filePath, maxLines = 200, maxBytes = 1024 * 1024) {
  const st = await fs.promises.stat(filePath);
  const start = Math.max(0, st.size - maxBytes);

  const fh = await fs.promises.open(filePath, 'r');
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(Math.min(len, maxBytes));
    await fh.read(buf, 0, buf.length, start);
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    return lines.slice(-maxLines).join('\n');
  } finally {
    await fh.close();
  }
}

function getByPath(obj, p) {
  const parts = p.split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setByPath(obj, p, value) {
  const parts = p.split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function isPlainObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function flattenPatch(prefix, obj, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flattenPatch(p, v, out);
    else out[p] = v;
  }
  return out;
}

function applyAllowedPatch(cfg, patch, allowList) {
  const flat = flattenPatch('', patch, {});
  const rejected = [];
  const applied = [];
  for (const [p, v] of Object.entries(flat)) {
    if (!allowList.includes(p)) {
      rejected.push(p);
      continue;
    }
    setByPath(cfg, p, v);
    applied.push(p);
  }
  return { applied, rejected };
}

async function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${Date.now()}`);
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, filePath);
}

function startAdminServer({ logger, cfgPath, cfgRef, state, requestRestart, setTarget, clearRecentEvents, setTimerInterval, logDir, logPrefixes }) {
  let pkgVersion = '';
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
    if (pj && pj.version) pkgVersion = pj.version;
  } catch (e) {}
  let gitRevCount = '';
  let gitShortHash = '';
  try { gitRevCount = execSync('git rev-list --count HEAD', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) {}
  try { gitShortHash = execSync('git rev-parse --short HEAD', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) {}
  const semanticVersion = gitRevCount ? `1.0.${gitRevCount}` : (pkgVersion || '1.0.0');
  const buildVersion = gitShortHash ? `${semanticVersion} (${gitShortHash})` : semanticVersion;

  const cfg = cfgRef();
  const adminCfg = cfg.admin || {};
  const enabled = adminCfg.enabled !== false;

  if (!enabled) {
    logger.info('Admin UI disabled (cfg.admin.enabled=false)');
    return { stop: async () => {} };
  }

  const host = adminCfg.host || '0.0.0.0';
  const port = adminCfg.port || 8080;
  const token = adminCfg.token || null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Optional bearer token auth
  app.use((req, res, next) => {
    if (!token) return next();
    const hdr = req.headers.authorization || '';
    const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7).trim() : null;
    const xTok = (req.headers['x-admin-token'] || '').toString().trim() || null;
    const qTok = (req.query.token || '').toString().trim() || null;
    const got = bearer || xTok || qTok;
    if (got && got === token) return next();
    res.status(401).json({ ok: false, error: 'unauthorized' });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, at: nowIso() }));

  app.get('/admin/api/status', (req, res) => {
    res.json({ ok: true, at: nowIso(), cfgPath, version: buildVersion, gitHash: gitShortHash || null, state: state.snapshot() });
  });

  app.get('/admin/api/settings', (req, res) => {
    const c = cfgRef();
    res.json({
      ok: true,
      at: nowIso(),
      cfgPath,
      config: c,
      settings: {
        admin: c.admin || {},
        post: c.post || {},
        logging: c.logging || {},
        defaults: c.defaults || {},
        decoder: c.decoder || {}
      }
    });
  });

  // Patch a SAFE subset of config, optionally persist to config.json (default true)
  
  // Patch a SAFE subset of config, optionally persist to config.json (default true)
  app.put('/admin/api/settings', async (req, res) => {
    try {
      const patch = req.body || {};
      const persist = (req.query.persist ?? 'true').toString().toLowerCase() !== 'false';

      // Apply patch to the live config first (so Set (no save) works)
      const live = cfgRef();

      const allowList = [
        // Admin
        'admin.enabled', 'admin.host', 'admin.port', 'admin.token',
        // Posting
        'post.enabled', 'post.baseUrl', 'post.path', 'post.method',
        'post.timeoutMs', 'post.retries', 'post.retryDelayMs', 'post.retryBackoffMultiplier',
        'post.queueDrainMaxPerTick',
        // Timer webhook
        'timer.enabled', 'timer.baseUrl', 'timer.path', 'timer.intervalSec', 'timer.timeoutMs', 'timer.retries', 'timer.retryDelayMs', 'timer.retryBackoffMultiplier',
        // Logging behavior
        'logging.dir', 'logging.suppressStatus',
        // Defaults
        'defaults.mode', 'defaults.tcpHost', 'defaults.tcpPort', 'defaults.udpListenPort', 'defaults.connectTimeoutMs',
        // Decoder reconnect tuning
        'decoder.reconnect.baseDelayMs', 'decoder.reconnect.maxDelayMs',
        'decoder.reconnect.backoffFactor', 'decoder.reconnect.jitterRatio', 'decoder.reconnect.connectTimeoutMs'
      ];

      const { applied, rejected } = applyAllowedPatch(live, patch, allowList);

      if (persist) {
        await atomicWriteJson(cfgPath, live);
      }

      logger.infoMeta('Admin settings updated', { appliedCount: applied.length, rejectedCount: rejected.length, persist });

      res.json({ ok: true, applied, rejected, persist });
    } catch (e) {
      logger.errorMeta('Admin settings update failed', { message: e?.message });
      res.status(400).json({ ok: false, error: e?.message || 'settings update failed' });
    }
  });

  app.post('/admin/api/restart', (req, res) => {
    res.json({ ok: true, at: nowIso(), restarting: true });
    setTimeout(() => requestRestart('admin requested restart'), 250).unref();
  });

  app.post('/admin/api/events/clear', (req, res) => {
    try {
      if (typeof clearRecentEvents === 'function') clearRecentEvents();
      res.json({ ok: true, at: nowIso(), cleared: true });
    } catch (e) {
      logger.errorMeta('Admin event clear failed', { message: e?.message });
      res.status(500).json({ ok: false, error: e?.message || 'event clear failed' });
    }
  });

  
  
  // Update decoder targets (in-memory), optionally persist defaults.tcpHosts to config.json
  app.put('/admin/api/target', async (req, res) => {
    try {
      const body = req.body || {};
      const persist = (req.query.persist === 'true' || body.persist === true);
      const targets = normalizeTargetList(body);

      if (targets.length === 0) return res.status(400).json({ ok: false, error: 'at least one valid target is required' });

      // Update live config defaults
      const c = cfgRef();
      c.defaults = c.defaults || {};
      c.defaults.tcpHosts = targets.map((target) => ({ ip: target.ip, port: target.port }));
      delete c.defaults.tcpHost;
      c.defaults.tcpPort = targets[0].port;

      if (persist) {
        await atomicWriteJson(cfgPath, c);
      }

      if (typeof setTarget === 'function') {
        setTarget({ targets });
      }

      res.json({ ok: true, at: nowIso(), targets, persist });
    } catch (e) {
      logger.errorMeta('Admin target update failed', { message: e?.message });
      res.status(400).json({ ok: false, error: e?.message || 'target update failed' });
    }
  });

  
  // Update timer interval (in-memory), optionally persist timer.intervalSec to config.json
  app.put('/admin/api/timer/interval', async (req, res) => {
    try {
      const body = req.body || {};
      const intervalSec = safeInt(body.intervalSec, null);
      const persist = (req.query.persist === 'true' || body.persist === true);

      if (!intervalSec || intervalSec < 5 || intervalSec > 3600) {
        return res.status(400).json({ ok: false, error: 'intervalSec must be between 5 and 3600' });
      }

      const c = cfgRef();
      c.timer = c.timer || {};
      c.timer.intervalSec = intervalSec;

      if (typeof setTimerInterval === 'function') {
        setTimerInterval(intervalSec);
      }

      if (persist) {
        await atomicWriteJson(cfgPath, c);
      }

      res.json({ ok: true, at: nowIso(), intervalSec, persist });
    } catch (e) {
      logger.errorMeta('Admin timer interval update failed', { message: e?.message });
      res.status(400).json({ ok: false, error: e?.message || 'timer interval update failed' });
    }
  });

  // Clear (truncate) the newest log file for the selected log name
  app.post('/admin/api/log/clear', async (req, res) => {
    try {
      const name = (req.query.name || 'main').toString();
      const dir = logDir || path.join(process.cwd(), 'logs');
      const prefixes = logPrefixes || { main: 'p3', http: 'p3-http', json: 'p3-json', 'post-errors': 'p3-post-errors' };
      const prefix = prefixes[name];
      if (!prefix) return res.status(400).json({ ok: false, error: `unknown log name: ${name}` });

      const filePath = await findNewestLogFile(dir, prefix);
      if (!filePath) return res.status(404).json({ ok: false, error: 'log file not found', dir, prefix });

      await fs.promises.truncate(filePath, 0);
      res.json({ ok: true, at: nowIso(), cleared: true, name, file: path.basename(filePath) });
    } catch (e) {
      logger.errorMeta('Admin log clear failed', { message: e?.message });
      res.status(500).json({ ok: false, error: e?.message || 'log clear failed' });
    }
  });

app.get('/admin/api/log/tail', async (req, res) => {
    try {
      const name = (req.query.name || 'main').toString();
      const lines = Math.min(1000, Math.max(10, safeInt(req.query.lines, 200)));
      const dir = logDir || path.join(process.cwd(), 'logs');
      const prefixes = logPrefixes || { main: 'p3', http: 'p3-http', json: 'p3-json', 'post-errors': 'p3-post-errors' };
      const prefix = prefixes[name];
      if (!prefix) return res.status(400).json({ ok: false, error: `unknown log name: ${name}` });

      const filePath = await findNewestLogFile(dir, prefix);
      if (!filePath) return res.status(404).json({ ok: false, error: 'log file not found', dir, prefix });

      const content = await tailFile(filePath, lines);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(content);
    } catch (e) {
      logger.errorMeta('Admin log tail failed', { message: e?.message });
      res.status(500).json({ ok: false, error: e?.message || 'log tail failed' });
    }
  });
app.get('/admin', (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>p3-bridge admin dashboard</title>
  <style>
    :root{--bg:#f3f6fb;--panel:#ffffff;--bd:#d7dfec;--muted:#5f6b7a;--ink:#111827;--accent:#2563eb;--accent2:#4f46e5;--ok:#0f766e}
    body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;line-height:1.35;background:linear-gradient(180deg,#eef3ff 0,#f8fbff 180px,var(--bg) 181px);color:var(--ink)}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(37,99,235,0.18);position:sticky;top:0;background:rgba(255,255,255,0.88);backdrop-filter:blur(8px);z-index:10}
    .brand{font-weight:800;display:flex;gap:8px;align-items:center}
    .brand .pill{font-size:11px;padding:3px 8px;border-radius:999px;background:rgba(37,99,235,0.12);color:var(--accent);border:1px solid rgba(37,99,235,0.28)}
    .topbar-nav{display:flex;gap:8px;flex-wrap:wrap}
    .navlink{padding:7px 12px;border-radius:10px;text-decoration:none;border:1px solid rgba(37,99,235,0.20);color:#123; background:#fff}
    .navlink.active{border-color:rgba(37,99,235,0.4);background:rgba(37,99,235,0.08);color:var(--accent)}
    .page{padding:14px}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .card{border:1px solid var(--bd);border-radius:14px;padding:12px;min-width:220px;background:var(--panel);box-shadow:0 8px 24px rgba(31,41,55,0.06)}
    pre{background:#f7faff;padding:10px;border-radius:10px;overflow:auto;border:1px solid #e3ebfb}
    button{padding:8px 11px;border-radius:10px;border:1px solid #b8c7ea;background:#fff;cursor:pointer;font-weight:600}
    button:hover{background:#eef4ff}
    input,textarea,select{width:100%;box-sizing:border-box;padding:8px 9px;border-radius:10px;border:1px solid #c8d5ef;background:#fff}
    small{color:var(--muted)}
    h2{margin:0 0 10px}
    h3{margin:0 0 8px;font-size:14px}
    /* keep existing helper classes */
    .codebox{max-height:240px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:12px;white-space:pre;}
    .muted{color:var(--muted)}
    .small{font-size:12px}
    
</style>
</head>
<body>
  <header class="topbar">
    <div class="brand">p3-bridge admin <span class="pill">v${semanticVersion}</span> <span class="pill">git ${gitShortHash || 'n/a'}</span></div>
    <nav class="topbar-nav">
      <a class="navlink active" href="/admin">Dashboard</a>
      <a class="navlink " href="/admin/settings">Settings</a>
      <a class="navlink " href="/admin/logs">Logs</a>
    </nav>
  </header>
  <main class="page">
  <div class="row">
    <div class="card">
      <h3>Status</h3>
      <div id="status">Loading…</div>
      <small id="updated"></small>
    </div>
    <div class="card">
      <h3>Actions</h3>
      <button id="restartBtn">Restart service</button>
      <p><small>Restart exits the process; systemd restarts it.</small></p>
    </div>
    <div class="card" style="min-width:320px;max-width:360px">
      <h3>Targets</h3>
      <label><small>Decoder targets</small></label>
      <textarea id="targetList" rows="5" spellcheck="false" placeholder="192.168.1.50:5403&#10;192.168.1.51:5404"></textarea>
      <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">
        <button id="setTargetBtn">Set</button>
        <button id="setTargetPersistBtn">Set and Save</button>
      </div>
      <small>Enter one <code>ip:port</code> target per line. “Set” updates the in-memory target list immediately. “Set and Save” also writes <code>defaults.tcpHosts</code> to config.json.</small>
      <div id="targetResult"></div>
    </div>
    <div class="card" style="min-width:260px;max-width:320px">
      <h3>Timer</h3>
      <label><small>Interval (seconds)</small></label>
      <input id="timerIntervalSec" type="number" min="5" max="3600" placeholder="30" />
      <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">
        <button id="setTimerBtn">Set</button>
        <button id="setTimerPersistBtn">Set and Save</button>
      </div>
      <small>Updates timer heartbeat frequency. Use the main Restart button if you also changed other timer settings (baseUrl/path).</small>
      <div id="timerResult"></div>
    </div>
  </div>
  <div class="row" style="margin-top:10px">
    <div class="card" style="width:100%;min-width:320px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">Transponder Events</h3>
        <button id="clearEventsBtn">Clear</button>
      </div>
      <div id="eventFeed" class="codebox" style="max-height:360px"></div>
      <small>Most recent events from any connected MYLAPS box.</small>
    </div>
  </div>

  <script>
async function api(path, opts){
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=>({ok:false,error:'bad json'}));
  if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}
function fmt(n){ return (n==null)?'—':String(n); }
function formatDuration(totalSec){
  let sec = Number(totalSec);
  if (!Number.isFinite(sec) || sec < 0) return '—';
  sec = Math.floor(sec);
  if (sec < 60) return sec + ' second' + (sec === 1 ? '' : 's');

  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const parts = [];
  function pushPart(value, label){
    if (!value) return;
    parts.push(value + ' ' + label + (value === 1 ? '' : 's'));
  }

  pushPart(days, 'day');
  pushPart(hours, 'hour');
  pushPart(minutes, 'minute');
  if (!days && !hours && seconds) pushPart(seconds, 'second');

  return parts.slice(0, 3).join(' ');
}
function escapeHtml(value){
  return String(value)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}
const targetPalette = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d', '#db2777'];
function targetsForDisplay(s){
  return Array.isArray(s.targets) && s.targets.length
    ? s.targets
    : [{ ip: s.ip, port: s.port }].filter((target) => target.ip || target.port);
}
function targetKey(target){
  return escapeHtml(fmt(target.ip)) + ':' + escapeHtml(fmt(target.port));
}
function targetColorMap(s){
  const map = {};
  targetsForDisplay(s).forEach((target, idx) => {
    map[targetKey(target)] = targetPalette[idx % targetPalette.length];
  });
  return map;
}
function colorSwatch(color){
  return '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + color + ';margin-right:6px;vertical-align:middle"></span>';
}
function targetRows(s){
  const targets = targetsForDisplay(s);
  const colors = targetColorMap(s);
  const label = targets.length > 1 ? 'Targets' : 'Target';
  const body = targets.length
    ? targets.map((target) => {
        const status = target.status || (s.tcpConnected ? 'connected' : 'disconnected');
        const key = targetKey(target);
        return colorSwatch(colors[key] || '#6b7280') + key + ' <span class="muted">(' + escapeHtml(status) + ')</span>';
      }).join('<br/>')
    : '—';
  return '<b>' + label + ':</b><br/>' + body;
}
function targetListValue(s){
  const targets = targetsForDisplay(s);
  return targets.map((target) => fmt(target.ip) + ':' + fmt(target.port)).join('\\n');
}
function parseTargets(text){
  return String(text || '')
    .replaceAll('\\r', '')
    .split('\\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.lastIndexOf(':');
      if (idx <= 0 || idx === line.length - 1) throw new Error('Each target must be in ip:port format');
      const ip = line.slice(0, idx).trim();
      const port = Number(line.slice(idx + 1).trim());
      if (!ip) throw new Error('Target IP is required');
      if (!port || port < 1 || port > 65535) throw new Error('Target port must be between 1 and 65535');
      return { ip, port };
    });
}
function eventFeedHtml(events, s){
  if(!Array.isArray(events) || !events.length) return '<span class="muted">No transponder events received yet.</span>';
  const colors = targetColorMap(s || {});
  return events.map((event) => {
    const at = event && event.at ? new Date(event.at) : null;
    const ts = at && !Number.isNaN(at.getTime())
      ? at.toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' })
      : '—';
    const sourceColor = colors[escapeHtml(event && event.source ? event.source : '')] || '#6b7280';
    const swatch = colorSwatch(sourceColor);
    if(event && event.type === 'passing' && event.transponder){
      const color = event.duplicate ? '#b91c1c' : 'inherit';
      const details = Array.isArray(event.details) ? event.details.map((part) => escapeHtml(part)).join(' | ') : '';
      const body = escapeHtml(event.prefix || 'Event') + ': Transponder <span style="color:' + color + ';font-weight:600">' + escapeHtml(event.transponder) + '</span>' + (details ? ' | ' + details : '');
      return '<div><span class="muted">' + escapeHtml(ts) + '</span> ' + swatch + body + '</div>';
    }
    return '<div><span class="muted">' + escapeHtml(ts) + '</span> ' + swatch + escapeHtml(event.summary || 'event') + '</div>';
  }).join('');
}

async function refresh(){
  try{
    const j = await api('/admin/api/status');
    const s = j.state;
    // populate target inputs if empty
    const tlist = document.getElementById('targetList');
    if(tlist && !tlist.value) tlist.value = targetListValue(s);
    const tint = document.getElementById('timerIntervalSec');
    if(tint && !tint.value && j?.state?.timerIntervalSec) tint.value = String(j.state.timerIntervalSec);

    const lines = [];
    lines.push('<b>Uptime:</b> ' + formatDuration(s.uptimeSec));
    lines.push('<b>Build:</b> ' + fmt(j.version));
    lines.push('<b>Mode:</b> ' + fmt(s.mode));
    lines.push(targetRows(s));
    lines.push('<b>Messages:</b> total=' + fmt(s.msgTotal) + ', ok=' + fmt(s.msgOk) + ', parseErr=' + fmt(s.msgParseErr) + ', suppressed=' + fmt(s.msgSuppressed));
    lines.push('<b>Posts:</b> ok=' + fmt(s.postOk) + ', fail=' + fmt(s.postFail) + ', queued=' + fmt(s.postQueued) + ', queueSize=' + fmt(s.postQueueSize));
    if (typeof s.timerOk !== 'undefined') {
      lines.push('<b>Timer:</b> ok=' + fmt(s.timerOk) + ', fail=' + fmt(s.timerFail) + ', last=' + (s.lastTimerAt || '')); 
    }
    document.getElementById('status').innerHTML = lines.join('<br/>');
    document.getElementById('eventFeed').innerHTML = eventFeedHtml(s.recentEvents, s);
    document.getElementById('updated').textContent = 'Updated ' + j.at;
  }catch(e){
    document.getElementById('status').textContent = 'Error: ' + e.message;
    document.getElementById('eventFeed').textContent = 'Error: ' + e.message;
  }
}

const __el_restartBtn = document.getElementById('restartBtn');
if(__el_restartBtn) __el_restartBtn.onclick = async () => {
  if(!confirm('Restart p3-bridge now?')) return;
  try{ await api('/admin/api/restart', {method:'POST'}); }catch(e){ alert(e.message); }
};

const __el_clearEventsBtn = document.getElementById('clearEventsBtn');
if(__el_clearEventsBtn) __el_clearEventsBtn.onclick = async () => {
  if(!confirm('Clear recent transponder events?')) return;
  try{
    await api('/admin/api/events/clear', {method:'POST'});
    await refresh();
  }catch(e){
    alert(e.message);
  }
};


async function setTarget(persist){
  const out = document.getElementById('targetResult');
  out.textContent = '';
  try{
    const targets = parseTargets(document.getElementById('targetList').value);
    if(!targets.length) throw new Error('Enter at least one target');
    const qs = [];
    if(persist) qs.push('persist=true');

    const url = '/admin/api/target' + (qs.length ? ('?' + qs.join('&')) : '');
    const r = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ targets, persist })});
    const j = await r.json().catch(()=>({ok:false,error:'bad json'}));
    if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
    out.innerHTML = '<small>Updated ' + targets.length + ' target' + (targets.length === 1 ? '' : 's') + (persist ? ' (saved)' : '') + '</small>';
    if(persist) window.location.reload();
  }catch(e){
    out.innerHTML = '<small style="color:#b00">Error: ' + e.message + '</small>';
  }
}

async function tailOnce(){
  const name = document.getElementById('logName').value;
  const lines = Number(document.getElementById('logLines').value) || 200;
  const hint = document.getElementById('logHint');
  const pre = document.getElementById('logOut');
  hint.textContent = 'Loading…';
  try{
    const r = await fetch('/admin/api/log/tail?name=' + encodeURIComponent(name) + '&lines=' + encodeURIComponent(lines));
    const t = await r.text();
    if(!r.ok){
      try{ const j = JSON.parse(t); throw new Error(j.error || ('HTTP '+r.status)); }catch(_){ throw new Error('HTTP '+r.status); }
    }
    // Optionally filter timer heartbeats from http log view
    let out = t || '';
    const hideTimer = (name === 'http') && document.getElementById('hideTimerHttp')?.checked;
    if (hideTimer && out) {
      const before = out.split('\\n');
      const after = before.filter(line => !String(line).toLowerCase().includes('timerwebhook'));
      out = after.join('\\n');
    }
    pre.textContent = out;
    hint.textContent = 'Showing last ' + lines + ' lines of ' + name + ' (newest file)' + (hideTimer ? ' (timerWebhook filtered)' : '');
    pre.scrollTop = pre.scrollHeight;
  }catch(e){
    hint.textContent = '';
    pre.textContent = 'Error: ' + e.message;
  }
}

let logTimer = null;
function setAuto(on){
  const btn = document.getElementById('tailAutoBtn');
  btn.dataset.on = on ? '1' : '0';
  btn.textContent = 'Auto: ' + (on ? 'on' : 'off');
  if(logTimer){ clearInterval(logTimer); logTimer = null; }
  if(on){
    tailOnce();
    logTimer = setInterval(tailOnce, 2000);
  }
}


const __el_setTargetBtn = document.getElementById('setTargetBtn');
if(__el_setTargetBtn) __el_setTargetBtn.onclick = () => setTarget(false);
const __el_setTargetPersistBtn = document.getElementById('setTargetPersistBtn');
if(__el_setTargetPersistBtn) __el_setTargetPersistBtn.onclick = () => setTarget(true);

async function setTimerInterval(persist){
  const val = Number(document.getElementById('timerIntervalSec').value);
  const out = document.getElementById('timerResult');
  out.textContent = '';
  try{
    if(!val || val < 5 || val > 3600) throw new Error('interval must be between 5 and 3600 seconds');
    const url = '/admin/api/timer/interval' + (persist ? '?persist=true' : '');
    const r = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ intervalSec: val, persist })});
    const j = await r.json().catch(()=>({ok:false,error:'bad json'}));
    if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
    out.innerHTML = '<small>Timer interval set to ' + val + 's' + (persist ? ' (saved)' : '') + '</small>';
    if(persist) window.location.reload();
  }catch(e){
    out.innerHTML = '<small style="color:#b00">Error: ' + e.message + '</small>';
  }
}

const __el_setTimerBtn = document.getElementById('setTimerBtn');
if(__el_setTimerBtn) __el_setTimerBtn.onclick = () => setTimerInterval(false);
const __el_setTimerPersistBtn = document.getElementById('setTimerPersistBtn');
if(__el_setTimerPersistBtn) __el_setTimerPersistBtn.onclick = () => setTimerInterval(true);


const __el_clearLogBtn = document.getElementById('clearLogBtn');
if(__el_clearLogBtn) __el_clearLogBtn.onclick = async () => {
  const name = document.getElementById('logName').value;
  if(!confirm('Clear current ' + name + ' log file for today?')) return;
  try{
    await api('/admin/api/log/clear?name=' + encodeURIComponent(name), {method:'POST'});
    await tailOnce();
  }catch(e){
    alert(e.message);
  }
};

const __el_tailBtn = document.getElementById('tailBtn');
if(__el_tailBtn) __el_tailBtn.onclick = () => tailOnce();
const __el_tailAutoBtn = document.getElementById('tailAutoBtn');
if(__el_tailAutoBtn) __el_tailAutoBtn.onclick = () => setAuto(document.getElementById('tailAutoBtn').dataset.on !== '1');

const logNameEl = document.getElementById('logName');
const hideTimerEl = document.getElementById('hideTimerHttp');
function updateHideToggle(){
  const isHttp = (logNameEl && logNameEl.value === 'http');
  if (!hideTimerEl) return;
  hideTimerEl.disabled = !isHttp;
  // visually deemphasize when not applicable
  const wrap = hideTimerEl.closest('label');
  if (wrap) wrap.style.opacity = isHttp ? '1' : '0.5';
}
if (logNameEl) logNameEl.onchange = () => { updateHideToggle(); tailOnce(); };
if (hideTimerEl) hideTimerEl.onchange = () => tailOnce();
updateHideToggle();

  if (document.getElementById('status')) {
  refresh();
  setInterval(refresh, 2000);
}
</script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  app.get('/admin/settings', (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>p3-bridge admin settings</title>
  <style>
    :root{--bg:#f3f6fb;--panel:#ffffff;--bd:#d7dfec;--muted:#5f6b7a;--ink:#111827;--accent:#2563eb;--accent2:#4f46e5}
    body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;line-height:1.35;background:linear-gradient(180deg,#eef3ff 0,#f8fbff 180px,var(--bg) 181px);color:var(--ink)}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(37,99,235,0.18);position:sticky;top:0;background:rgba(255,255,255,0.88);backdrop-filter:blur(8px);z-index:10}
    .brand{font-weight:800;display:flex;gap:8px;align-items:center}
    .brand .pill{font-size:11px;padding:3px 8px;border-radius:999px;background:rgba(37,99,235,0.12);color:var(--accent);border:1px solid rgba(37,99,235,0.28)}
    .topbar-nav{display:flex;gap:8px;flex-wrap:wrap}
    .navlink{padding:7px 12px;border-radius:10px;text-decoration:none;border:1px solid rgba(37,99,235,0.20);color:#123; background:#fff}
    .navlink.active{border-color:rgba(37,99,235,0.4);background:rgba(37,99,235,0.08);color:var(--accent)}
    .page{padding:14px}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .card{border:1px solid var(--bd);border-radius:14px;padding:12px;min-width:220px;background:var(--panel);box-shadow:0 8px 24px rgba(31,41,55,0.06)}
    pre{background:#f7faff;padding:10px;border-radius:10px;overflow:auto;border:1px solid #e3ebfb}
    button{padding:8px 11px;border-radius:10px;border:1px solid #b8c7ea;background:#fff;cursor:pointer;font-weight:600}
    button:hover{background:#eef4ff}
    textarea{width:100%;box-sizing:border-box;padding:8px 9px;border-radius:10px;border:1px solid #c8d5ef;background:#fff}
    small{color:var(--muted)}
    h2{margin:0 0 10px}
    h3{margin:0 0 8px;font-size:14px}
    .codebox{max-height:240px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:12px;white-space:pre;}
    .small{font-size:12px}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">p3-bridge admin <span class="pill">v${semanticVersion}</span> <span class="pill">git ${gitShortHash || 'n/a'}</span></div>
    <nav class="topbar-nav">
      <a class="navlink " href="/admin">Dashboard</a>
      <a class="navlink active" href="/admin/settings">Settings</a>
      <a class="navlink " href="/admin/logs">Logs</a>
    </nav>
  </header>
  <main class="page">
    <div class="row">
      <div class="card" style="flex:1;min-width:320px">
        <h3>Update settings (JSON patch)</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 8px 0">
          <button class="secBtn" data-sec="__full">Load full config</button>
          <button class="secBtn" data-sec="post">Load post</button>
          <button class="secBtn" data-sec="timer">Load timer</button>
          <button class="secBtn" data-sec="logging">Load logging</button>
          <button class="secBtn" data-sec="admin">Load admin</button>
          <button class="secBtn" data-sec="defaults">Load defaults</button>
          <button class="secBtn" data-sec="decoder.reconnect">Load decoder.reconnect</button>
        </div>
        <div class="small">Current config (read-only)</div>
        <pre id="configCurrent" class="codebox"></pre>
        <div class="small" style="margin-top:8px">Edit JSON (only allowlisted keys are applied)</div>
        <textarea id="patch" rows="14" spellcheck="false"></textarea>
        <div style="display:flex;gap:10px;margin-top:8px">
          <button id="applyBtn">Set</button>
          <button id="applyPersistBtn">Set and Save</button>
        </div>
        <small>Only a safe subset of fields can be changed (post.*, timer.*, logging.*, admin.*, defaults.*, decoder.reconnect.*).</small>
        <div id="applyResult"></div>
      </div>
    </div>
    <h3>Raw snapshot</h3>
    <pre id="raw"></pre>
  </main>

  <script>
async function api(path, opts){
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=>({ok:false,error:'bad json'}));
  if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}
function fmt(n){ return (n==null)?'—':String(n); }

async function refresh(){
  try{
    const j = await api('/admin/api/status');
    document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
  }catch(e){
    document.getElementById('raw').textContent = 'Error: ' + e.message;
  }
}

async function apply(persist){
  let patch;
  try{ patch = JSON.parse(document.getElementById('patch').value); }
  catch(e){ alert('Patch JSON is invalid: ' + e.message); return; }
  const url = '/admin/api/settings?persist=' + (persist ? 'true' : 'false');
  try{
    const j = await api(url, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch)});
    document.getElementById('applyResult').innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>';
    if(persist) window.location.reload();
  }catch(e){
    document.getElementById('applyResult').innerHTML = '<pre>'+e.message+'</pre>';
  }
}

const __el_applyBtn = document.getElementById('applyBtn');
if(__el_applyBtn) __el_applyBtn.onclick = () => apply(false);
const __el_applyPersistBtn = document.getElementById('applyPersistBtn');
if(__el_applyPersistBtn) __el_applyPersistBtn.onclick = () => apply(true);

async function loadSection(sec){
  const out = document.getElementById('applyResult');
  out.textContent = '';
  try{
    const j = await api('/admin/api/settings');
    const cfg = (j && j.config) ? j.config : {};
    const cur = document.getElementById('configCurrent');
    if(cur) cur.textContent = JSON.stringify(cfg, null, 2);

    let payload = {};
    if(sec === '__full'){
      payload = cfg;
    } else if(sec === 'decoder.reconnect'){
      payload = { decoder: { reconnect: (cfg.decoder && cfg.decoder.reconnect) ? cfg.decoder.reconnect : {} } };
    } else {
      payload[sec] = (cfg && cfg[sec]) ? cfg[sec] : {};
    }

    const patch = document.getElementById('patch');
    if(patch){
      patch.value = JSON.stringify(payload, null, 2);
      patch.dataset.dirty = '0';
    }
    out.innerHTML = '<small>Loaded current <b>'+sec+'</b> config into the editor.</small>';
  }catch(e){
    out.innerHTML = '<pre>'+e.message+'</pre>';
  }
}

document.querySelectorAll('.secBtn').forEach(btn=>{
  btn.addEventListener('click', ()=> loadSection(btn.getAttribute('data-sec')));
});

const patchEl = document.getElementById('patch');
if(patchEl){
  patchEl.addEventListener('input', ()=> { patchEl.dataset.dirty = '1'; });
}

loadSection('__full');
refresh();
setInterval(refresh, 2000);
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  app.get('/admin/logs', (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>p3-bridge admin logs</title>
  <style>
    :root{--bg:#f3f6fb;--panel:#ffffff;--bd:#d7dfec;--muted:#5f6b7a;--ink:#111827;--accent:#2563eb;--accent2:#4f46e5}
    body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;line-height:1.35;background:linear-gradient(180deg,#eef3ff 0,#f8fbff 180px,var(--bg) 181px);color:var(--ink)}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(37,99,235,0.18);position:sticky;top:0;background:rgba(255,255,255,0.88);backdrop-filter:blur(8px);z-index:10}
    .brand{font-weight:800;display:flex;gap:8px;align-items:center}
    .brand .pill{font-size:11px;padding:3px 8px;border-radius:999px;background:rgba(37,99,235,0.12);color:var(--accent);border:1px solid rgba(37,99,235,0.28)}
    .topbar-nav{display:flex;gap:8px;flex-wrap:wrap}
    .navlink{padding:7px 12px;border-radius:10px;text-decoration:none;border:1px solid rgba(37,99,235,0.20);color:#123; background:#fff}
    .navlink.active{border-color:rgba(37,99,235,0.4);background:rgba(37,99,235,0.08);color:var(--accent)}
    .page{padding:14px}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .card{border:1px solid var(--bd);border-radius:14px;padding:12px;min-width:220px;background:var(--panel);box-shadow:0 8px 24px rgba(31,41,55,0.06)}
    pre{background:#f7faff;padding:10px;border-radius:10px;overflow:auto;border:1px solid #e3ebfb}
    button{padding:8px 11px;border-radius:10px;border:1px solid #b8c7ea;background:#fff;cursor:pointer;font-weight:600}
    button:hover{background:#eef4ff}
    input,textarea,select{width:100%;box-sizing:border-box;padding:8px 9px;border-radius:10px;border:1px solid #c8d5ef;background:#fff}
    small{color:var(--muted)}
    h2{margin:0 0 10px}
    h3{margin:0 0 8px;font-size:14px}
    /* keep existing helper classes */
    .codebox{max-height:240px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:12px;white-space:pre;}
    .muted{color:var(--muted)}
    .small{font-size:12px}
    
</style>
</head>
<body>
  <header class="topbar">
    <div class="brand">p3-bridge admin <span class="pill">v${semanticVersion}</span> <span class="pill">git ${gitShortHash || 'n/a'}</span></div>
    <nav class="topbar-nav">
      <a class="navlink " href="/admin">Dashboard</a>
      <a class="navlink " href="/admin/settings">Settings</a>
      <a class="navlink active" href="/admin/logs">Logs</a>
    </nav>
  </header>
  <main class="page">
<h2 style="margin:0 0 10px">Logs</h2>
  <div class="row">
    <div class="card" style="flex:1;min-width:320px">
      <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div style="min-width:180px;flex:0">
          <label><small>Log</small></label>
          <select id="logName" style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #ccc">
            <option value="main">main</option>
            <option value="http">http</option>
            <option value="json">json</option>
            <option value="post-errors">post-errors</option>
          </select>
        </div>
        <div style="min-width:120px;flex:0">
          <label><small>Lines</small></label>
          <input id="logLines" type="number" min="10" max="1000" value="200" />
        </div>
        <div style="min-width:220px;flex:0;align-self:flex-end">
          <label style="display:flex;gap:8px;align-items:center;user-select:none">
            <input id="hideTimerHttp" type="checkbox" />
            <small>Hide timerWebhook (http log)</small>
          </label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button id="tailBtn">Tail</button>
          <button id="clearLogBtn">Clear</button>
          <button id="tailAutoBtn" data-on="0">Auto: off</button>
        </div>
        <small id="logHint"></small>
      </div>
      <pre id="logOut" style="max-height:420px"></pre>
    </div>
  </div>


</main>

<script>
async function api(path, opts){
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=>({ok:false,error:'bad json'}));
  if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}

async function tailOnce(){
  const name = document.getElementById('logName').value;
  const lines = Number(document.getElementById('logLines').value) || 200;
  const hint = document.getElementById('logHint');
  const pre = document.getElementById('logOut');
  hint.textContent = 'Loading…';
  try{
    const r = await fetch('/admin/api/log/tail?name=' + encodeURIComponent(name) + '&lines=' + encodeURIComponent(lines));
    const t = await r.text();
    if(!r.ok){
      try{ const j = JSON.parse(t); throw new Error(j.error || ('HTTP '+r.status)); }catch(_){ throw new Error('HTTP '+r.status); }
    }
    // Optionally filter timer heartbeats from http log view
    let out = t || '';
    const hideTimer = (name === 'http') && document.getElementById('hideTimerHttp')?.checked;
    if (hideTimer && out) {
      const before = out.split('\\n');
      const after = before.filter(line => !String(line).toLowerCase().includes('timerwebhook'));
      out = after.join('\\n');
    }
    pre.textContent = out;
    hint.textContent = 'Showing last ' + lines + ' lines of ' + name + ' (newest file)' + (hideTimer ? ' (timerWebhook filtered)' : '');
    pre.scrollTop = pre.scrollHeight;
  }catch(e){
    hint.textContent = '';
    pre.textContent = 'Error: ' + e.message;
  }
}

let logTimer = null;
function setAuto(on){
  const btn = document.getElementById('tailAutoBtn');
  btn.dataset.on = on ? '1' : '0';
  btn.textContent = 'Auto: ' + (on ? 'on' : 'off');
  if(logTimer){ clearInterval(logTimer); logTimer = null; }
  if(on){
    tailOnce();
    logTimer = setInterval(tailOnce, 2000);
  }
}

const __el_clearLogBtn = document.getElementById('clearLogBtn');
if(__el_clearLogBtn) __el_clearLogBtn.onclick = async () => {
  const name = document.getElementById('logName').value;
  if(!confirm('Clear current ' + name + ' log file for today?')) return;
  try{
    await api('/admin/api/log/clear?name=' + encodeURIComponent(name), {method:'POST'});
    await tailOnce();
  }catch(e){
    alert(e.message);
  }
};

const __el_tailBtn = document.getElementById('tailBtn');
if(__el_tailBtn) __el_tailBtn.onclick = () => tailOnce();
const __el_tailAutoBtn = document.getElementById('tailAutoBtn');
if(__el_tailAutoBtn) __el_tailAutoBtn.onclick = () => setAuto(document.getElementById('tailAutoBtn').dataset.on !== '1');

const logNameEl = document.getElementById('logName');
const hideTimerEl = document.getElementById('hideTimerHttp');
function updateHideToggle(){
  const isHttp = (logNameEl && logNameEl.value === 'http');
  if (!hideTimerEl) return;
  hideTimerEl.disabled = !isHttp;
  // visually deemphasize when not applicable
  const wrap = hideTimerEl.closest('label');
  if (wrap) wrap.style.opacity = isHttp ? '1' : '0.5';
}
if (logNameEl) logNameEl.onchange = () => { updateHideToggle(); tailOnce(); };
if (hideTimerEl) hideTimerEl.onchange = () => tailOnce();
updateHideToggle();
</script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  const server = app.listen(port, host, () => {
    logger.infoMeta('Admin UI listening', { host, port, tokenRequired: Boolean(token) });
  });

  return {
    stop: async () => new Promise((resolve) => server.close(() => resolve()))
  };
}

module.exports = { startAdminServer };
