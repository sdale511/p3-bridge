const fs = require('fs');
const path = require('path');
const express = require('express');

function nowIso() { return new Date().toISOString(); }


function safeInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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

function startAdminServer({ logger, cfgPath, cfgRef, state, requestRestart, setTarget, setTimerInterval, logDir, logPrefixes }) {
  const zipVersion = 'v13';
  let pkgVersion = '';
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
    if (pj && pj.version) pkgVersion = pj.version;
  } catch (e) {}
  const appVersion = pkgVersion ? `${zipVersion} (pkg v${pkgVersion})` : zipVersion;

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
    res.json({ ok: true, at: nowIso(), cfgPath, version: appVersion, state: state.snapshot() });
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

  
  
  // Update decoder target (in-memory), optionally persist defaults.tcpHost/tcpPort to config.json
  app.put('/admin/api/target', async (req, res) => {
    try {
      const body = req.body || {};
      const ip = (body.ip || '').toString().trim();
      const port = safeInt(body.port, null);
      const persist = (req.query.persist === 'true' || body.persist === true);

      if (!ip) return res.status(400).json({ ok: false, error: 'ip required' });
      if (!port || port < 1 || port > 65535) return res.status(400).json({ ok: false, error: 'valid port required' });

      // Update live config defaults
      const c = cfgRef();
      c.defaults = c.defaults || {};
      c.defaults.tcpHost = ip;
      c.defaults.tcpPort = port;

      if (persist) {
        await atomicWriteJson(cfgPath, c);
      }

      if (typeof setTarget === 'function') {
        setTarget({ ip, port });
      }

      res.json({ ok: true, at: nowIso(), ip, port, persist });
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
  <title>p3-bridge admin</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:16px;line-height:1.4}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px;min-width:260px}
    pre{background:#f6f8fa;padding:10px;border-radius:8px;overflow:auto}
    button{padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}
    button:hover{background:#f2f2f2}
    input,textarea{width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #ccc}
    small{color:#666}
  
    .codebox{max-height:240px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:12px;white-space:pre;}
    .muted{color:#666}
    .small{font-size:12px}
</style>
</head>
<body>
  <h2>p3-bridge admin <span class="muted">${appVersion}</span></h2>
  <div class="row">
    <div class="card">
      <h3>Status</h3>
      <div id="status">Loading…</div>
      <small id="updated"></small>
    </div>
    <div class="card">
      <h3>Actions</h3>
      <button id="restartBtn">Restart service</button>
      <p><small>Restart triggers process exit; systemd should restart it if configured with Restart=always.</small></p>
    </div>
    <div class="card" style="min-width:320px;max-width:360px">
      <h3>Target</h3>
      <label><small>Decoder IP</small></label>
      <input id="targetIp" placeholder="e.g. 192.168.1.50" />
      <label style="margin-top:6px;display:block"><small>Port</small></label>
      <input id="targetPort" type="number" min="1" max="65535" placeholder="e.g. 5403" />
      <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">
        <button id="setTargetBtn">Set</button>
        <button id="setTargetPersistBtn">Set and Save</button>
      </div>
      <small>“Set” changes the in-memory target immediately (reconnects). “Set and Save” also writes defaults.tcpHost/tcpPort to config.json.</small>
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
      <div class="small muted">Current config (read-only)</div>
      <pre id="configCurrent" class="codebox"></pre>
      <div class="small muted" style="margin-top:8px">Edit JSON (only allowlisted keys are applied)</div>
      <textarea id="patch" rows="10" spellcheck="false"></textarea>
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


  <h3>Logs</h3>
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
    const s = j.state;
    // populate target inputs if empty
    const tip = document.getElementById('targetIp');
    const tport = document.getElementById('targetPort');
    if(tip && !tip.value) tip.value = (s.ip || '');
    if(tport && !tport.value) tport.value = (s.port || '');
    const tint = document.getElementById('timerIntervalSec');
    if(tint && !tint.value && j?.state?.timerIntervalSec) tint.value = String(j.state.timerIntervalSec);

    const lines = [];
    lines.push('<b>Uptime:</b> ' + fmt(s.uptimeSec) + 's');
    lines.push('<b>Mode:</b> ' + fmt(s.mode) + ' | <b>Target:</b> ' + fmt(s.ip) + ':' + fmt(s.port));
    lines.push('<b>Transport:</b> ' + (s.tcpConnected ? 'TCP connected' : (s.mode==='tcp' ? 'TCP disconnected' : 'UDP listening')));
    lines.push('<b>Messages:</b> total=' + fmt(s.msgTotal) + ', ok=' + fmt(s.msgOk) + ', parseErr=' + fmt(s.msgParseErr) + ', suppressed=' + fmt(s.msgSuppressed));
    lines.push('<b>Posts:</b> ok=' + fmt(s.postOk) + ', fail=' + fmt(s.postFail) + ', queued=' + fmt(s.postQueued) + ', queueSize=' + fmt(s.postQueueSize));
    if (typeof s.timerOk !== 'undefined') {
      lines.push('<b>Timer:</b> ok=' + fmt(s.timerOk) + ', fail=' + fmt(s.timerFail) + ', last=' + (s.lastTimerAt || '')); 
    }
    document.getElementById('status').innerHTML = lines.join('<br/>');
    document.getElementById('updated').textContent = 'Updated ' + j.at;
    document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
  }catch(e){
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
}

document.getElementById('restartBtn').onclick = async () => {
  if(!confirm('Restart p3-bridge now?')) return;
  try{ await api('/admin/api/restart', {method:'POST'}); }catch(e){ alert(e.message); }
};


async function apply(persist){
  let patch;
  try{ patch = JSON.parse(document.getElementById('patch').value); }
  catch(e){ alert('Patch JSON is invalid: ' + e.message); return; }
  const url = '/admin/api/settings?persist=' + (persist ? 'true' : 'false');
  try{
    const j = await api(url, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch)});
    document.getElementById('applyResult').innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>';
  }catch(e){
    document.getElementById('applyResult').innerHTML = '<pre>'+e.message+'</pre>';
  }
}

document.getElementById('applyBtn').onclick = () => apply(false);
document.getElementById('applyPersistBtn').onclick = () => apply(true);

// Load current config into the JSON patch box (template for allowed changes)
async function loadSection(sec){
  const out = document.getElementById('applyResult');
  out.textContent = '';
  try{
    const j = await api('/admin/api/settings');
    const cfg = (j && j.config) ? j.config : {};
    // Always show the full current config tree (read-only)
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

// mark editor dirty on manual edits
const patchEl = document.getElementById('patch');
if(patchEl){
  patchEl.addEventListener('input', ()=> { patchEl.dataset.dirty = '1'; });
}

// Load full config tree into view/editor on page load
loadSection('__full');

async function setTarget(persist){
  const ip = document.getElementById('targetIp').value.trim();
  const port = Number(document.getElementById('targetPort').value);
  const out = document.getElementById('targetResult');
  out.textContent = '';
  try{
    const qs = [];
    if(persist) qs.push('persist=true');

    const url = '/admin/api/target' + (qs.length ? ('?' + qs.join('&')) : '');
    const r = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ip, port, persist })});
    const j = await r.json().catch(()=>({ok:false,error:'bad json'}));
    if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
    out.innerHTML = '<small>Updated target to ' + ip + ':' + port + (persist ? ' (saved)' : '') + '</small>';
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


document.getElementById('setTargetBtn').onclick = () => setTarget(false);
document.getElementById('setTargetPersistBtn').onclick = () => setTarget(true);

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
  }catch(e){
    out.innerHTML = '<small style="color:#b00">Error: ' + e.message + '</small>';
  }
}

document.getElementById('setTimerBtn').onclick = () => setTimerInterval(false);
document.getElementById('setTimerPersistBtn').onclick = () => setTimerInterval(true);


document.getElementById('clearLogBtn').onclick = async () => {
  const name = document.getElementById('logName').value;
  if(!confirm('Clear current ' + name + ' log file for today?')) return;
  try{
    await api('/admin/api/log/clear?name=' + encodeURIComponent(name), {method:'POST'});
    await tailOnce();
  }catch(e){
    alert(e.message);
  }
};

document.getElementById('tailBtn').onclick = () => tailOnce();
document.getElementById('tailAutoBtn').onclick = () => setAuto(document.getElementById('tailAutoBtn').dataset.on !== '1');

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

refresh();
setInterval(refresh, 2000);
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
