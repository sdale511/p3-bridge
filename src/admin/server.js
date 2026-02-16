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

function startAdminServer({ logger, cfgPath, cfgRef, state, requestRestart, setTarget, logDir, logPrefixes }) {
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
    res.json({ ok: true, at: nowIso(), cfgPath, state: state.snapshot() });
  });

  app.get('/admin/api/settings', (req, res) => {
    const c = cfgRef();
    res.json({
      ok: true,
      at: nowIso(),
      cfgPath,
      settings: {
        admin: c.admin || {},
        post: c.post || {},
        logging: c.logging || {},
        defaults: c.defaults || {},
        decoder: c.decoder || {}
      }
    });
  });

  // Patch a SAFE subset of config.json, optionally trigger restart (default true)
  app.put('/admin/api/settings', async (req, res) => {
    try {
      const patch = req.body || {};
      const restart = (req.query.restart ?? 'true').toString().toLowerCase() !== 'false';

      const raw = await fs.promises.readFile(cfgPath, 'utf8');
      const current = JSON.parse(raw);

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

      const { applied, rejected } = applyAllowedPatch(current, patch, allowList);
      await atomicWriteJson(cfgPath, current);

      logger.infoMeta('Admin settings updated', { appliedCount: applied.length, rejectedCount: rejected.length, restart });

      res.json({ ok: true, applied, rejected, restart });

      if (restart) {
        // Give the response time to flush before exit
        setTimeout(() => requestRestart('admin settings updated'), 250).unref();
      }
    } catch (e) {
      logger.errorMeta('Admin settings update failed', { message: e?.message });
      res.status(400).json({ ok: false, error: e?.message || 'settings update failed' });
    }
  });

  app.post('/admin/api/restart', (req, res) => {
    res.json({ ok: true, at: nowIso(), restarting: true });
    setTimeout(() => requestRestart('admin requested restart'), 250).unref();
  });

  
  app.put('/admin/api/target', async (req, res) => {
    try {
      const body = req.body || {};
      const ip = (body.ip || '').toString().trim();
      const port = safeInt(body.port, null);
      const persist = (req.query.persist === 'true' || body.persist === true);
      const restart = (req.query.restart === 'true' || body.restart === true);

      if (!ip) return res.status(400).json({ ok: false, error: 'ip required' });
      if (!port || port < 1 || port > 65535) return res.status(400).json({ ok: false, error: 'valid port required' });

      if (persist) {
        const c = cfgRef();
        c.defaults = c.defaults || {};
        c.defaults.tcpHost = ip;
        c.defaults.tcpPort = port;
        await atomicWriteJson(cfgPath, c);
      }

      if (typeof setTarget === 'function') {
        setTarget({ ip, port });
      }

      res.json({ ok: true, at: nowIso(), ip, port, persist, restart });

      if (restart) {
        setTimeout(() => requestRestart('admin requested restart (target change)'), 250).unref();
      }
    } catch (e) {
      logger.errorMeta('Admin target update failed', { message: e?.message });
      res.status(400).json({ ok: false, error: e?.message || 'target update failed' });
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
  </style>
</head>
<body>
  <h2>p3-bridge admin</h2>
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
        <button id="setTargetBtn">Set + Reconnect</button>
        <button id="setTargetPersistBtn">Save + Restart</button>
      </div>
      <small>“Set + Reconnect” changes the in-memory target immediately. “Save + Restart” writes defaults.tcpHost/tcpPort to config and restarts.</small>
      <div id="targetResult"></div>
    </div>
    <div class="card" style="flex:1;min-width:320px">
      <h3>Update settings (JSON patch)</h3>
      <textarea id="patch" rows="10" spellcheck="false">{\n  \"post\": { \"enabled\": true }\n}</textarea>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button id="applyBtn">Apply + Restart</button>
        <button id="applyNoRestartBtn">Apply (no restart)</button>
      </div>
      <small>Only a safe subset of fields can be changed (post.*, logging.suppressStatus, admin.*, defaults.*, decoder.reconnect.*).</small>
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
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button id="tailBtn">Tail</button>
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

async function apply(restart){
  let patch;
  try{ patch = JSON.parse(document.getElementById('patch').value); }
  catch(e){ alert('Patch JSON is invalid: ' + e.message); return; }
  const url = '/admin/api/settings?restart=' + (restart ? 'true' : 'false');
  try{
    const j = await api(url, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch)});
    document.getElementById('applyResult').innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>';
  }catch(e){
    document.getElementById('applyResult').innerHTML = '<pre>'+e.message+'</pre>';
  }
}

document.getElementById('applyBtn').onclick = () => apply(true);
document.getElementById('applyNoRestartBtn').onclick = () => apply(false);

async function setTarget(persist, doRestart){
  const ip = document.getElementById('targetIp').value.trim();
  const port = Number(document.getElementById('targetPort').value);
  const out = document.getElementById('targetResult');
  out.textContent = '';
  try{
    const qs = [];
    if(persist) qs.push('persist=true');
    if(doRestart) qs.push('restart=true');
    const url = '/admin/api/target' + (qs.length ? ('?' + qs.join('&')) : '');
    const r = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ip, port, persist, restart: doRestart })});
    const j = await r.json().catch(()=>({ok:false,error:'bad json'}));
    if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
    out.innerHTML = '<small>Updated target to ' + ip + ':' + port + (persist ? ' (saved)' : '') + (doRestart ? ' (restarting...)' : '') + '</small>';
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
    pre.textContent = t || '';
    hint.textContent = 'Showing last ' + lines + ' lines of ' + name + ' (newest file)';
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


document.getElementById('setTargetBtn').onclick = () => setTarget(false,false);
document.getElementById('setTargetPersistBtn').onclick = () => setTarget(true,true);
document.getElementById('tailBtn').onclick = () => tailOnce();
document.getElementById('tailAutoBtn').onclick = () => setAuto(document.getElementById('tailAutoBtn').dataset.on !== '1');
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
