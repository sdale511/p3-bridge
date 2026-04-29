#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { loadConfig } = require('./config');
const { makeLogger } = require('./logger');
const { StreamP3Decoder } = require('./p3/decoder');
const { buildUrl, postWithRetries } = require('./http/poster');
const { PostQueue } = require('./http/postQueue');

const { startAdminServer } = require('./admin/server');
const { createState } = require('./admin/state');

function pickPort(mode, cfg, cliPort) {
  if (cliPort) return cliPort;
  if (mode === 'udp') return cfg.defaults?.udpListenPort ?? 5303;
  return cfg.defaults?.tcpPort ?? 5403;
}

function normalizeTcpTargets(cfg, cliIp, cliPort) {
  if (cliIp) return [{ ip: cliIp, port: cliPort ?? (cfg.defaults?.tcpPort ?? 5403) }];

  const fromList = Array.isArray(cfg.defaults?.tcpHosts) ? cfg.defaults.tcpHosts : [];
  const parsed = fromList
    .map((entry) => {
      if (typeof entry === 'string') {
        return { ip: entry, port: cfg.defaults?.tcpPort ?? 5403 };
      }
      if (!entry || typeof entry !== 'object') return null;
      const ip = entry.ip || entry.host;
      if (!ip) return null;
      return { ip, port: Number(entry.port) || (cfg.defaults?.tcpPort ?? 5403) };
    })
    .filter(Boolean);
  if (parsed.length > 0) return parsed;

  if (cfg.defaults?.tcpHost) return [{ ip: cfg.defaults.tcpHost, port: cfg.defaults?.tcpPort ?? 5403 }];
  return [];
}

function syncStateTargets(state, mode, tcpTargets, udpTargetIp, udpTargetPort) {
  const stateIp = mode === 'tcp' ? tcpTargets.map((t) => t.ip).join(',') : udpTargetIp;
  const statePort = mode === 'tcp'
    ? (tcpTargets.length === 1 ? tcpTargets[0].port : null)
    : udpTargetPort;
  state.setBase({ mode, ip: stateIp, port: statePort });
  state.setTargets(mode === 'tcp' ? tcpTargets : [{ ip: udpTargetIp, port: udpTargetPort }]);
  state.setTcpTargetsTotal(mode === 'tcp' ? tcpTargets.length : 0);
}

function formatEventTime(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const ms = num > 1e12 ? Math.round(num / 1000) : num;
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function summarizeParsedEvent(parsed, decoded, source, options = {}) {
  const decoderId = decoded.decoderId || null;
  const prefix = decoderId ? `Box ${decoderId}` : source;
  const torName = (parsed.torName || 'record').toString();
  const duplicate = Boolean(options.duplicate);
  const eventId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (torName === 'passing') {
    const transponder = String(decoded.tranCode || decoded.transponder || 'unknown');
    const passingNumber = decoded.passingNumber != null ? `pass #${decoded.passingNumber}` : null;
    const strength = decoded.strength != null ? `strength ${decoded.strength}` : null;
    const hits = decoded.hits != null ? `${decoded.hits} hits` : null;
    const when = formatEventTime(decoded.utcTime || decoded.rtcTime);
    const details = [
      passingNumber,
      when ? `at ${when}` : null,
      strength,
      hits,
      duplicate ? 'duplicate' : null
    ].filter(Boolean);
    return {
      id: eventId,
      at: new Date().toISOString(),
      type: 'passing',
      source,
      duplicate,
      transponder,
      prefix,
      details,
      summary: `${prefix}: Transponder ${transponder}${details.length ? ` | ${details.join(' | ')}` : ''}`
    };
  }

  if (torName === 'loopTrigger') {
    const code = decoded.code || 'loop trigger';
    const when = formatEventTime(decoded.utcTime || decoded.rtcTime);
    return {
      id: eventId,
      at: new Date().toISOString(),
      type: 'loopTrigger',
      source,
      summary: `${prefix}: Loop ${code}${when ? ` at ${when}` : ''}`
    };
  }

  return {
    id: eventId,
    at: new Date().toISOString(),
    type: torName,
    source,
    summary: `${prefix}: ${torName}`
  };
}

function loadRecentEvents(filePath, maxEntries = 100) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const limit = Math.max(1, Number(maxEntries) || 100);
    return Array.isArray(parsed)
      ? parsed.filter((event) => event && typeof event === 'object').slice(0, limit)
      : [];
  } catch (_) {
    return [];
  }
}

function createRecentEventPersister(filePath, maxEntries = 100) {
  const limit = Math.max(1, Number(maxEntries) || 100);
  let pending = false;
  let queuedEvents = null;

  const flush = async () => {
    pending = true;
    while (queuedEvents) {
      const events = queuedEvents;
      queuedEvents = null;
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, JSON.stringify(events, null, 2) + '\n', 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      } catch (_) {}
    }
    pending = false;
  };

  return (events) => {
    queuedEvents = Array.isArray(events) ? events.slice(0, limit) : [];
    if (!pending) void flush();
  };
}

function isSystemdManaged() {
  return Boolean(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM || process.env.NOTIFY_SOCKET);
}

function getLaunchctlJobTarget() {
  if (process.platform !== 'darwin') return null;
  const label = (process.env.LAUNCH_JOB_LABEL || process.env.XPC_SERVICE_NAME || '').trim();
  if (!label) return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const domain = uid === 0 ? 'system' : `gui/${uid}`;
  return { label, domain, target: `${domain}/${label}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAttemptRateLimiter(minIntervalMs) {
  const intervalMs = Math.max(0, Number(minIntervalMs) || 0);
  if (!intervalMs) {
    return async () => {};
  }

  let nextAllowedAt = 0;
  let chain = Promise.resolve();
  return async () => {
    const waitForTurn = chain.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextAllowedAt - now);
      if (waitMs > 0) await sleep(waitMs);
      nextAllowedAt = Date.now() + intervalMs;
    });
    chain = waitForTurn.catch(() => {});
    return waitForTurn;
  };
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .scriptName('p3-bridge')
    .usage('$0 [ip] [port] [options]')
    .positional('ip', { describe: 'Decoder IP (TCP) or bind IP (UDP). If omitted, uses config defaults.', type: 'string' })
    .positional('port', { describe: 'TCP port (connect) or UDP port (listen)', type: 'number' })
    .option('mode', { choices: ['tcp', 'udp'], default: undefined, describe: 'Transport mode' })
    .option('tcp', { type: 'boolean', describe: 'Force TCP mode' })
    .option('udp', { type: 'boolean', describe: 'Force UDP mode' })
    .option('config', { type: 'string', describe: 'Path to config json' })
    .option('no-post', { type: 'boolean', default: false, describe: 'Disable HTTPS posting (dry-run)' })
    .option('no-timer', { type: 'boolean', default: false, describe: 'Disable timer webhook posts' })
    .option('no-console-log', { type: 'boolean', default: false, describe: 'Disable console logging' })
    .option('no-file-log', { type: 'boolean', default: false, describe: 'Disable general rotating file log' })
    .option('no-http-log', { type: 'boolean', default: false, describe: 'Disable HTTP rotating file log' })
    .option('no-json-log', { type: 'boolean', default: false, describe: 'Disable JSON payload rotating file log' })
    .option('suppress-status', { type: 'boolean', default: false, describe: 'Suppress Status TOR records from logs/JSON/POST' })
    .option('debug', { type: 'boolean', default: false, describe: 'Verbose logging' })
    .help()
    .argv;

  const { cfg, path: cfgPath } = loadConfig(argv.config);

  const mode = argv.mode || (argv.udp ? 'udp' : (argv.tcp ? 'tcp' : (cfg.defaults?.mode || 'tcp')));
  const cliIp = argv._[0];
  const cliPort = argv._[1] ? Number(argv._[1]) : undefined;
  let udpTargetIp = cliIp || cfg.defaults?.udpBindIp || cfg.defaults?.bindIp;
  let udpTargetPort = pickPort(mode, cfg, cliPort);
  let tcpTargets = normalizeTcpTargets(cfg, cliIp, cliPort);

  if (mode === 'udp' && !udpTargetIp) {
    console.error('No bind IP provided. Pass <ip> on the command line or set defaults.udpBindIp (or defaults.bindIp) in config.json.');
    process.exit(2);
  }
  if (mode === 'tcp' && tcpTargets.length === 0) {
    console.error('No TCP target IP provided. Pass <ip> on the command line or set defaults.tcpHost / defaults.tcpHosts in config.json.');
    process.exit(2);
  }

  const logDir = cfg.logging?.dir || path.join(process.cwd(), 'logs');
  const recentEventsPath = path.join(logDir, 'transponder-events.json');
  const logDatePattern = cfg.logging?.datePattern || 'YYYY-MM-DD';
  const logMaxFiles = cfg.logging?.maxFiles || '7d';
  const logLevel = cfg.logging?.level || 'info';

  const logger = makeLogger({
    name: 'main',
    dir: logDir,
    filenamePrefix: 'p3',
    filename: cfg.logging?.filename,
    datePattern: logDatePattern,
    maxFiles: logMaxFiles,
    level: logLevel,
    enableConsole: !argv.noConsoleLog,
    enableFile: !argv.noFileLog
  });
  if (argv.debug) logger.level = 'debug';

  const httpLogger = makeLogger({
    name: 'http',
    dir: logDir,
    filenamePrefix: 'p3-http',
    filename: cfg.logging?.httpFilename,
    datePattern: logDatePattern,
    maxFiles: logMaxFiles,
    level: logLevel,
    enableConsole: false,
    enableFile: !argv.noHttpLog
  });

  const jsonLogger = makeLogger({
    name: 'json',
    dir: logDir,
    filenamePrefix: 'p3-json',
    filename: cfg.logging?.jsonFilename,
    datePattern: logDatePattern,
    maxFiles: logMaxFiles,
    level: logLevel,
    enableConsole: false,
    enableFile: !argv.noJsonLog
  });

  const postErrorsLogger = makeLogger({
    name: 'post-errors',
    dir: logDir,
    filenamePrefix: 'p3-post-errors',
    datePattern: logDatePattern,
    maxFiles: logMaxFiles,
    level: logLevel,
    enableConsole: false,
    enableFile: true
  });


  const recentEventLimit = Math.max(1, Number(cfg.defaults?.transponderEventLogEntries) || 100);
  const state = createState({ maxRecentEvents: recentEventLimit });
  state.setRecentEvents(loadRecentEvents(recentEventsPath, recentEventLimit));
  const persistRecentEvents = createRecentEventPersister(recentEventsPath, recentEventLimit);
  syncStateTargets(state, mode, tcpTargets, udpTargetIp, udpTargetPort);

  let adminHandle = null;

  // Refs used for shutdown / admin restart
  const tcpClients = new Map();
  let udpSocket = null;
  let stopping = false;
  let connectTcpClient = null;
  let stopTcpClient = null;
  let resyncTcpClients = null;

  const requestRestart = (reason) => {
    void gracefulShutdown(reason || 'restart', 0, true);
  };

  const setTarget = ({ targets }) => {
    if (mode !== 'tcp') return;
    const nextTargets = Array.isArray(targets)
      ? targets
        .map((target) => ({
          ip: String(target?.ip || '').trim(),
          port: Number(target?.port) || null
        }))
        .filter((target) => target.ip && target.port)
      : [];
    if (nextTargets.length === 0) return;

    tcpTargets.length = 0;
    nextTargets.forEach((target) => tcpTargets.push(target));
    syncStateTargets(state, mode, tcpTargets, udpTargetIp, udpTargetPort);

    if (typeof resyncTcpClients === 'function') {
      resyncTcpClients();
    }
  };
  const clearRecentEvents = () => {
    state.clearRecentEvents();
    persistRecentEvents([]);
  };
  const updateRecentEventPost = (eventId, patch = {}) => {
    if (!eventId) return;
    if (state.updateRecentEvent(eventId, patch)) {
      persistRecentEvents(state.snapshot().recentEvents);
    }
  };
  const resetStats = () => {
    state.resetStats();
    if (postEnabled) state.setPostQueueSize(postQueue.size());
  };


  const gracefulShutdown = async (reason, exitCode = 0, isRestart = false) => {
    if (stopping) return;
    stopping = true;

    logger.warnMeta(isRestart ? 'Restarting' : 'Shutting down', { reason });

    const launchctlJob = getLaunchctlJobTarget();

    if (isRestart && launchctlJob) {
      try {
        const child = spawn('launchctl', ['kickstart', '-k', launchctlJob.target], {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        logger.infoMeta('Requested launchctl restart', launchctlJob);
      } catch (err) {
        logger.errorMeta('Failed to request launchctl restart', {
          target: launchctlJob.target,
          message: err?.message
        });
      }
    } else if (isRestart && !isSystemdManaged()) {
      try {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        logger.infoMeta('Spawned replacement process for restart', { pid: child.pid });
      } catch (err) {
        logger.errorMeta('Failed to spawn replacement process for restart', { message: err?.message });
      }
    }

    try { postQueue.stop(); } catch (_) {}
    try { if (adminHandle) await adminHandle.stop(); } catch (_) {}

    for (const client of tcpClients.values()) {
      try {
        if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
        client.reconnectTimer = null;
      } catch (_) {}
      try {
        if (client.socket) {
          try { client.socket.removeAllListeners(); } catch (_) {}
          try { client.socket.destroy(); } catch (_) {}
        }
        client.socket = null;
      } catch (_) {}
    }

    try {
      if (udpSocket) {
        try { udpSocket.close(); } catch (_) {}
      }
      udpSocket = null;
    } catch (_) {}

    // Give logs time to flush
    setTimeout(() => process.exit(exitCode), 150).unref?.();
  };

  adminHandle = startAdminServer({
    logger,
    cfgPath,
    cfgRef: () => cfg,
    state,
    requestRestart,
    setTarget,
    clearRecentEvents,
    resetStats,
    setTimerInterval,
    logDir,
    logPrefixes: { main: "p3", http: "p3-http", json: "p3-json", "post-errors": "p3-post-errors" }
  });
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM', 0, false); });


  const postEnabled = (cfg.post?.enabled !== false) && !argv.noPost;
  if (!postEnabled) logger.info('POST disabled (dry-run mode)');
  const waitForPostAttempt = createAttemptRateLimiter(cfg.post?.minIntervalMs ?? 500);

  const postQueue = new PostQueue({
    filePath: path.join(logDir, 'post-errors-queue.json'),
    errorLogger: postErrorsLogger,
    intervalMs: 30_000,
    drainMaxPerTick: cfg.post?.queueDrainMaxPerTick ?? 5,
    onChange: (size) => state.setPostQueueSize(size),
    onEntryResult: (entry, result) => {
      if (!entry?.eventId) return;
      if (result?.ok) {
        updateRecentEventPost(entry.eventId, {
          postStatus: 'posted',
          postLastStatus: result.status ?? null,
          postLastError: null
        });
      } else {
        updateRecentEventPost(entry.eventId, {
          postStatus: 'queued',
          postLastStatus: result?.status ?? null,
          postLastError: result?.error ?? null
        });
      }
    },
    postFn: async (entry) => {
      return postWithRetries({
        logger,
        httpLogger,
        method: entry.method,
        url: entry.url,
        data: entry.data,
        headers: entry.headers,
        timeoutMs: cfg.post.timeoutMs || 8000,
        retries: cfg.post.retries ?? 5,
        retryDelayMs: cfg.post.retryDelayMs ?? 500,
        retryBackoffMultiplier: cfg.post.retryBackoffMultiplier ?? 2,
        maxRetryDelayMs: cfg.post.maxRetryDelayMs ?? 8000,
        beforeAttempt: waitForPostAttempt,
        onRetry: (info) => {
          state.onPostRetry(info);
          updateRecentEventPost(entry.eventId, {
            postStatus: 'retrying',
            postRetries: Math.max(0, Number(info.attempt) || 0),
            postLastStatus: info.status ?? null
          });
        }
      });
    }
  });

  if (postEnabled) {
    state.setPostQueueSize(postQueue.size());
    if (postQueue.size() > 0) {
      logger.warnMeta('Loaded queued POST errors', { count: postQueue.size(), file: 'post-errors-queue.json' });
    }
    postQueue.start();
  }

// Timer webhook: periodic heartbeat to race control so it can end races even if UI isn't open.
  const timerEnabled = (cfg.timer?.enabled !== false) && !argv.noTimer;

  let timerIntervalHandle = null;
  let timerUrl = null;

  function buildTimerUrlFromCfg() {
    const timerBaseUrl = cfg.timer?.baseUrl;
    const timerPath = cfg.timer?.path || '/timerWebhook';
    if (!String(timerPath).toLowerCase().endsWith('timerwebhook')) {
      logger.warnMeta('Timer path does not end with timerWebhook', { path: timerPath });
    }
    try {
      return buildUrl(timerBaseUrl, timerPath);
    } catch (e) {
      logger.errorMeta('Timer webhook misconfigured (missing baseUrl?)', { message: e.message });
      return null;
    }
  }

  async function doTimerPostOnce() {
    const payload = { utc: Date.now() }; // milliseconds since epoch (UTC)
    await postWithRetries({
      logger,
      httpLogger,
      method: 'POST',
      url: timerUrl,
      data: payload,
      headers: cfg.timer?.headers || { 'Content-Type': 'application/json' },
      timeoutMs: cfg.timer?.timeoutMs || 5000,
      retries: cfg.timer?.retries ?? 2,
      retryDelayMs: cfg.timer?.retryDelayMs ?? 250,
      retryBackoffMultiplier: cfg.timer?.retryBackoffMultiplier ?? 2
    });
  }

  function stopTimerLoop() {
    if (timerIntervalHandle) {
      clearInterval(timerIntervalHandle);
      timerIntervalHandle = null;
    }
  }

  function startTimerLoop(intervalSec) {
    stopTimerLoop();
    if (!timerEnabled) return;
    timerUrl = buildTimerUrlFromCfg();
    if (!timerUrl) return;

    const sec = Math.max(5, Number(intervalSec || cfg.timer?.intervalSec || 30));
    state.setTimerIntervalSec(sec);
    logger.infoMeta('Timer webhook enabled', { url: timerUrl, intervalSec: sec });

    timerIntervalHandle = setInterval(async () => {
      try {
        await doTimerPostOnce();
        state.onTimerPostResult({ ok: true });
      } catch (err) {
        state.onTimerPostResult({ ok: false });
        logger.warnMeta('Timer webhook post failed', { message: err.message });
      }
    }, sec * 1000);
    timerIntervalHandle.unref?.();
  }

  // Exposed to admin server: change interval without restart
  function setTimerInterval(newIntervalSec) {
    cfg.timer = cfg.timer || {};
    cfg.timer.intervalSec = Number(newIntervalSec);
    startTimerLoop(cfg.timer.intervalSec);
  }

  if (!timerEnabled) {
    logger.info('Timer webhook disabled');
    state.setTimerIntervalSec(null);
  } else {
    startTimerLoop(cfg.timer?.intervalSec ?? 30);
  }


  const suppressStatus = Boolean(argv.suppressStatus || cfg.logging?.suppressStatus);
  const transponderDuplicateWindowSec = Math.max(0, Number(cfg.defaults?.transponderDuplicateWindowSec ?? 10) || 0);
  const transponderDuplicateWindowMs = transponderDuplicateWindowSec * 1000;
  const lastAcceptedTransponders = new Map();
  const isStatusRecord = (p) => {
    const torIsStatus = (typeof p.tor === 'number') && (p.tor === 0x0002);
    const name = (p.torName || '').toString().trim().toLowerCase();
    return torIsStatus || name === 'status';
  };

  if (suppressStatus) logger.info('Status suppression enabled (TOR 0x0002)');

  const handleParsedRecord = async (parsed, source) => {
    if (!parsed.ok) {
      state.onParseResult(parsed);
      logger.warnMeta('P3 parse error', parsed);
      return;
    }

    // Optionally suppress status records entirely
    if (suppressStatus && isStatusRecord(parsed)) {
      state.onParseResult(parsed, { suppressed: true });
      if (argv.debug) {
        logger.debugMeta('Suppressed status record', {
          tor: `0x${parsed.tor.toString(16).padStart(4, '0')}`,
          source,
          decoderId: parsed.fields?.find(f => f?.tofName === 'decoderId')?.value
        });
      }
      return;
    }

    // Build decoded (top-level convenience object)
    const decoded = {};
    for (const f of parsed.fields) {
      if (!f.tofName) continue;
      if (f.value === undefined) continue;
      const key = f.tofName;
      if (decoded[key] === undefined) decoded[key] = f.value;
      else if (Array.isArray(decoded[key])) decoded[key].push(f.value);
      else decoded[key] = [decoded[key], f.value];
    }

    const torName = (parsed.torName || '').toString().trim().toLowerCase();
    if (torName === 'passing' && transponderDuplicateWindowMs > 0) {
      const transponderKey = String(decoded.tranCode || decoded.transponder || '').trim();
      const eventTimeMsRaw = Number(decoded.utcTime || decoded.rtcTime || Date.now());
      const eventTimeMs = Number.isFinite(eventTimeMsRaw)
        ? (eventTimeMsRaw > 1e12 ? Math.round(eventTimeMsRaw / 1000) : eventTimeMsRaw)
        : Date.now();
      if (transponderKey) {
        const lastAcceptedAt = lastAcceptedTransponders.get(transponderKey);
        if (lastAcceptedAt != null && (eventTimeMs - lastAcceptedAt) < transponderDuplicateWindowMs) {
          state.onPassing({ duplicate: true });
          state.addRecentEvent(summarizeParsedEvent(parsed, decoded, source, { duplicate: true }));
          persistRecentEvents(state.snapshot().recentEvents);
          logger.infoMeta('Duplicate transponder passing suppressed', {
            source,
            transponder: transponderKey,
            duplicateWindowSec: transponderDuplicateWindowSec
          });
          return;
        }
        lastAcceptedTransponders.set(transponderKey, eventTimeMs);
      }
    }

    state.onParseResult(parsed);
    if (torName === 'passing') state.onPassing({ duplicate: false });

    if (!parsed.crc?.ok) {
      logger.warnMeta('P3 CRC mismatch (parsed anyway)', {
        tor: `0x${parsed.tor.toString(16).padStart(4,'0')}`,
        torName: parsed.torName,
        crcIn: parsed.crc.in,
        crcCalc: parsed.crc.calc
      });
    }

    // Commonly useful fields for concise console logging
    const tranCode = decoded.tranCode;

// Build a friendly JSON object
    const payload = {
      receivedAt: new Date().toISOString(),
      version: parsed.version,
      tor: parsed.tor,
      torName: parsed.torName,
      flags: parsed.flags,
      crcOk: parsed.crc.ok,
      source,
      decoded,
      fields: parsed.fields.map(f => ({
        tof: f.tof,
        tofName: f.tofName,
        length: f.length,
        type: f.type,
        value: f.value,
        valueType: f.valueType,
        dataHex: f.dataHex,
        dataAscii: f.dataAscii
      })),
      raw: argv.debug ? parsed.raw : undefined
    };

    const recentEvent = summarizeParsedEvent(parsed, decoded, source);
    state.addRecentEvent(recentEvent);
    persistRecentEvents(state.snapshot().recentEvents);

    jsonLogger.info(JSON.stringify(payload));

    if (!postEnabled) {
      logger.infoMeta('Record received', { torName: payload.torName, fieldCount: payload.fields.length, ...(tranCode ? { tranCode } : {}) });
      return;
    }

    const url = buildUrl(cfg.post.baseUrl, cfg.post.path);
    const method = (cfg.post.method || 'POST').toUpperCase();

    const headers = cfg.post.headers || { 'Content-Type': 'application/json' };

    try {
      const res = await postWithRetries({
        logger,
        httpLogger,
        method,
        url,
        data: payload,
        headers,
        timeoutMs: cfg.post.timeoutMs || 8000,
        retries: cfg.post.retries ?? 5,
        retryDelayMs: cfg.post.retryDelayMs ?? 500,
        retryBackoffMultiplier: cfg.post.retryBackoffMultiplier ?? 2,
        maxRetryDelayMs: cfg.post.maxRetryDelayMs ?? 8000,
        beforeAttempt: waitForPostAttempt,
        onRetry: (info) => {
          state.onPostRetry(info);
          updateRecentEventPost(recentEvent.id, {
            postStatus: 'retrying',
            postRetries: Math.max(0, Number(info.attempt) || 0),
            postLastStatus: info.status ?? null
          });
        }
      });

      if (!res.ok) {
        logger.errorMeta('Failed to post record (queued)', { torName: payload.torName, status: res.status, source, ...(tranCode ? { tranCode } : {}) });
        updateRecentEventPost(recentEvent.id, {
          postStatus: 'queued',
          postLastStatus: res.status
        });
        postQueue.enqueue({ method, url, headers, data: payload, reason: `HTTP ${res.status}`, eventId: recentEvent.id });
        state.onPostResult({ ok: false, queued: true });
        state.setPostQueueSize(postQueue.size());
      } else {
        logger.infoMeta('Posted record', { torName: payload.torName, status: res.status, source, ...(tranCode ? { tranCode } : {}) });
        updateRecentEventPost(recentEvent.id, {
          postStatus: 'posted',
          postLastStatus: res.status
        });
        state.onPostResult({ ok: true, queued: false });
      }
    } catch (e) {
      // Network / TLS / timeout errors after retries. Do NOT crash the server.
      const msg = e?.message || 'post exception';
      logger.errorMeta('Post exception (queued)', { torName: payload.torName, message: msg, source, ...(tranCode ? { tranCode } : {}) });
      updateRecentEventPost(recentEvent.id, {
        postStatus: 'queued',
        postLastError: msg
      });
      postQueue.enqueue({ method, url, headers, data: payload, reason: msg, eventId: recentEvent.id });
      state.onPostResult({ ok: false, queued: true });
      state.setPostQueueSize(postQueue.size());
    }
  };

  if (mode === 'tcp') {
    logger.infoMeta('Starting TCP clients', { targets: tcpTargets, config: cfgPath });

    const rcfg = {
      baseDelayMs: cfg.decoder?.reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: cfg.decoder?.reconnect?.maxDelayMs ?? 30000,
      backoffFactor: cfg.decoder?.reconnect?.backoffFactor ?? 1.8,
      jitterRatio: cfg.decoder?.reconnect?.jitterRatio ?? 0.2,
      connectTimeoutMs: cfg.decoder?.reconnect?.connectTimeoutMs ?? (cfg.defaults?.connectTimeoutMs ?? 8000),
    };

    const computeDelayMs = (attempt) => {
      // attempt starts at 1 for first retry
      const exp = Math.max(0, attempt - 1);
      let delay = rcfg.baseDelayMs * Math.pow(rcfg.backoffFactor, exp);
      delay = Math.min(delay, rcfg.maxDelayMs);
      const jitter = delay * rcfg.jitterRatio;
      // jitter in range [-jitter, +jitter]
      delay = delay + (Math.random() * 2 - 1) * jitter;
      return Math.max(0, Math.round(delay));
    };

    const clientKey = (target) => `${target.ip}:${target.port}`;
    const syncTcpTargetStatuses = () => {
      state.setTargets(tcpTargets.map((target) => ({
        ...target,
        status: tcpClients.get(clientKey(target))?.connected ? 'connected' : 'disconnected'
      })));
    };

    const scheduleReconnect = (client, reason) => {
      if (stopping) return;
      client.attempt += 1;
      const delayMs = computeDelayMs(client.attempt);
      state.onTcpReconnectScheduled(client.attempt);
      logger.warnMeta('TCP reconnect scheduled', { ip: client.ip, port: client.port, attempt: client.attempt, delayMs, reason });
      if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
      client.reconnectTimer = setTimeout(() => connectTcpClient(client), delayMs);
    };

    connectTcpClient = (client) => {
      if (stopping) return;
      if (client.reconnectTimer) { clearTimeout(client.reconnectTimer); client.reconnectTimer = null; }
      if (client.socket) {
        try { client.socket.removeAllListeners(); } catch (_) {}
        try { client.socket.destroy(); } catch (_) {}
        client.socket = null;
      }

      logger.infoMeta('TCP connecting', { ip: client.ip, port: client.port, attempt: client.attempt });
      client.socket = net.createConnection({ host: client.ip, port: client.port });
      client.socket.setNoDelay(true);

      // connect timeout
      const t = setTimeout(() => {
        if (!client.socket) return;
        logger.warnMeta('TCP connect timeout', { ip: client.ip, port: client.port, timeoutMs: rcfg.connectTimeoutMs });
        try { client.socket.destroy(new Error('connect timeout')); } catch (_) {}
      }, rcfg.connectTimeoutMs);

      client.socket.on('connect', () => {
        clearTimeout(t);
        client.attempt = 0;
        client.connected = true;
        state.onTcpConnect({ ip: client.ip, port: client.port });
        logger.infoMeta('TCP connected', { ip: client.ip, port: client.port });
      });

      client.socket.on('data', (chunk) => client.decoder.push(chunk));

      client.socket.on('error', (err) => {
        // keep running; close will trigger reconnect if needed
        logger.errorMeta('TCP error', { ip: client.ip, port: client.port, message: err.message, code: err.code });
      });

      client.socket.on('close', (hadError) => {
        clearTimeout(t);
        if (client.connected) {
          client.connected = false;
          state.onTcpDisconnect({ ip: client.ip, port: client.port });
        }
        logger.warnMeta('TCP connection closed', { ip: client.ip, port: client.port, hadError });
        scheduleReconnect(client, 'close');
      });
    };

    stopTcpClient = (client, reason = 'admin target change') => {
      if (!client) return;
      try {
        if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
        client.reconnectTimer = null;
      } catch (_) {}
      try {
        if (client.socket) {
          try { client.socket.removeAllListeners(); } catch (_) {}
          try { client.socket.destroy(new Error(reason)); } catch (_) {}
        }
      } catch (_) {}
      if (client.connected) {
        client.connected = false;
        state.onTcpDisconnect({ ip: client.ip, port: client.port });
      }
      client.socket = null;
    };

    resyncTcpClients = () => {
      const wanted = new Set(tcpTargets.map(clientKey));

      for (const [key, client] of tcpClients.entries()) {
        if (!wanted.has(key)) {
          stopTcpClient(client);
          tcpClients.delete(key);
        }
      }

      tcpTargets.forEach((target, idx) => {
        const key = clientKey(target);
        if (tcpClients.has(key)) return;
        const client = {
          id: idx,
          ip: target.ip,
          port: target.port,
          attempt: 0,
          socket: null,
          reconnectTimer: null,
          connected: false,
          decoder: new StreamP3Decoder((parsed) => handleParsedRecord(parsed, `${target.ip}:${target.port}`))
        };
        tcpClients.set(key, client);
        connectTcpClient(client);
      });

      syncTcpTargetStatuses();
    };

    resyncTcpClients();

    process.on('SIGINT', () => {
      stopping = true;
      for (const client of tcpClients.values()) {
        stopTcpClient(client, 'shutdown');
      }
      logger.info('Shutting down (SIGINT)');
      process.exit(0);
    });

  } else {
    logger.infoMeta('Starting UDP listener', { ip: udpTargetIp, port: udpTargetPort, config: cfgPath });
    const decoder = new StreamP3Decoder((parsed) => handleParsedRecord(parsed, `${udpTargetIp}:${udpTargetPort}`));
    udpSocket = dgram.createSocket('udp4');
    udpSocket.on('message', (msg) => decoder.push(msg));
    udpSocket.on('listening', () => logger.infoMeta('UDP listening', udpSocket.address()));
    udpSocket.on('error', (err) => logger.errorMeta('UDP error', { message: err.message }));
    udpSocket.bind(udpTargetPort, udpTargetIp);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
