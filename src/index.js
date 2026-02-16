#!/usr/bin/env node

const net = require('net');
const dgram = require('dgram');
const path = require('path');
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
  let targetIp = argv._[0] || cfg.defaults?.tcpHost || cfg.defaults?.udpBindIp || cfg.defaults?.bindIp;
  let targetPort = pickPort(mode, cfg, argv._[1] ? Number(argv._[1]) : undefined);

  if (!targetIp) {
    console.error('No target IP provided. Pass <ip> on the command line or set defaults.tcpHost (or defaults.udpBindIp) in config.json.');
    process.exit(2);
  }

  const logDir = cfg.logging?.dir || path.join(process.cwd(), 'logs');

  const logger = makeLogger({
    name: 'main',
    dir: logDir,
    filenamePrefix: 'p3',
    enableConsole: !argv.noConsoleLog,
    enableFile: !argv.noFileLog
  });
  if (argv.debug) logger.level = 'debug';

  const httpLogger = makeLogger({
    name: 'http',
    dir: logDir,
    filenamePrefix: 'p3-http',
    enableConsole: false,
    enableFile: !argv.noHttpLog
  });

  const jsonLogger = makeLogger({
    name: 'json',
    dir: logDir,
    filenamePrefix: 'p3-json',
    enableConsole: false,
    enableFile: !argv.noJsonLog
  });

  const postErrorsLogger = makeLogger({
    name: 'post-errors',
    dir: logDir,
    filenamePrefix: 'p3-post-errors',
    enableConsole: false,
    enableFile: true
  });


  const state = createState();
  state.setBase({ mode, ip: targetIp, port: targetPort });

  let adminHandle = null;

  // Refs used for shutdown / admin restart
  let tcpSocket = null;
  let tcpReconnectTimer = null;
  let udpSocket = null;
  let stopping = false;

  const requestRestart = (reason) => {
    void gracefulShutdown(reason || 'restart', 0, true);
  };

  const setTarget = ({ ip, port }) => {
    if (ip) targetIp = ip;
    if (port) targetPort = Number(port) || targetPort;
    state.setBase({ mode, ip: targetIp, port: targetPort });

    // For TCP mode, force a reconnect so the new target takes effect immediately.
    if (mode === 'tcp') {
      try {
        if (tcpSocket) tcpSocket.destroy(new Error('admin target change'));
      } catch (_) {}
    }
  };


  const gracefulShutdown = async (reason, exitCode = 0, isRestart = false) => {
    if (stopping) return;
    stopping = true;

    logger.warnMeta(isRestart ? 'Restarting' : 'Shutting down', { reason });

    try { postQueue.stop(); } catch (_) {}
    try { if (adminHandle) await adminHandle.stop(); } catch (_) {}

    try {
      if (tcpReconnectTimer) clearTimeout(tcpReconnectTimer);
      tcpReconnectTimer = null;
    } catch (_) {}

    try {
      if (tcpSocket) {
        try { tcpSocket.removeAllListeners(); } catch (_) {}
        try { tcpSocket.destroy(); } catch (_) {}
      }
      tcpSocket = null;
    } catch (_) {}

    try {
      if (udpSocket) {
        try { udpSocket.close(); } catch (_) {}
      }
      udpSocket = null;
    } catch (_) {}

    // Give logs time to flush
    setTimeout(() => process.exit(exitCode), 150).unref?.();
  };

  // Keep admin status accurate for queued posts
  setInterval(() => state.setPostQueueSize(postQueue.size()), 5000).unref?.();

  adminHandle = startAdminServer({
    logger,
    cfgPath,
    cfgRef: () => cfg,
    state,
    requestRestart,
    setTarget,
    logDir,
    logPrefixes: { main: "p3", http: "p3-http", json: "p3-json", "post-errors": "p3-post-errors" }
  });
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM', 0, false); });


  const postEnabled = (cfg.post?.enabled !== false) && !argv.noPost;
  if (!postEnabled) logger.info('POST disabled (dry-run mode)');

  const postQueue = new PostQueue({
    filePath: path.join(logDir, 'post-errors-queue.json'),
    errorLogger: postErrorsLogger,
    intervalMs: 30_000,
    drainMaxPerTick: cfg.post?.queueDrainMaxPerTick ?? 5,
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
        retryBackoffMultiplier: cfg.post.retryBackoffMultiplier ?? 2
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
if (!timerEnabled) {
  logger.info('Timer webhook disabled');
} else {
  const intervalSec = Number(cfg.timer?.intervalSec ?? 30);
  const intervalMs = Math.max(5, intervalSec) * 1000; // clamp to >=5s
  const timerBaseUrl = cfg.timer?.baseUrl;
  const timerPath = cfg.timer?.path || '/timerWebhook';
  if (!String(timerPath).toLowerCase().endsWith('timerwebhook')) {
    logger.warnMeta('Timer path does not end with timerWebhook', { path: timerPath });
  }
  let timerUrl = null;
  try {
    timerUrl = buildUrl(timerBaseUrl, timerPath);
  } catch (e) {
    logger.errorMeta('Timer webhook misconfigured (missing baseUrl?)', { message: e.message });
    // Do not crash the bridge; just disable timer loop.
    timerUrl = null;
  }

  if (timerUrl) {
    logger.infoMeta('Timer webhook enabled', { url: timerUrl, intervalSec: Math.round(intervalMs/1000) });
    const t = setInterval(async () => {
      try {
        const payload = { utc: Date.now() }; // milliseconds since epoch (UTC)
        const resp = await postWithRetries({
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
        state.onTimerPostResult({ ok: resp?.ok === true });
      } catch (err) {
        state.onTimerPostResult({ ok: false });
        logger.warnMeta('Timer webhook post failed', { message: err.message });
      }
    }, intervalMs);
    t.unref?.();
  }
}


  const suppressStatus = Boolean(argv.suppressStatus || cfg.logging?.suppressStatus);
  const isStatusRecord = (p) => {
    const torIsStatus = (typeof p.tor === 'number') && (p.tor === 0x0002);
    const name = (p.torName || '').toString().trim().toLowerCase();
    return torIsStatus || name === 'status';
  };

  if (suppressStatus) logger.info('Status suppression enabled (TOR 0x0002)');

  const decoder = new StreamP3Decoder(async (parsed) => {
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
          decoderId: parsed.fields?.find(f => f?.tofName === 'decoderId')?.value
        });
      }
      return;
    }

    state.onParseResult(parsed);

    if (!parsed.crc?.ok) {
      logger.warnMeta('P3 CRC mismatch (parsed anyway)', {
        tor: `0x${parsed.tor.toString(16).padStart(4,'0')}`,
        torName: parsed.torName,
        crcIn: parsed.crc.in,
        crcCalc: parsed.crc.calc
      });
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
        retryBackoffMultiplier: cfg.post.retryBackoffMultiplier ?? 2
      });

      if (!res.ok) {
        logger.errorMeta('Failed to post record (queued)', { torName: payload.torName, status: res.status, ...(tranCode ? { tranCode } : {}) });
        postQueue.enqueue({ method, url, headers, data: payload, reason: `HTTP ${res.status}` });
        state.onPostResult({ ok: false, queued: true });
        state.setPostQueueSize(postQueue.size());
      } else {
        logger.infoMeta('Posted record', { torName: payload.torName, status: res.status, ...(tranCode ? { tranCode } : {}) });
        state.onPostResult({ ok: true, queued: false });
        // On success, try to replay any queued errors immediately.
        void postQueue.drain('onSuccess');
      }
    } catch (e) {
      // Network / TLS / timeout errors after retries. Do NOT crash the server.
      const msg = e?.message || 'post exception';
      logger.errorMeta('Post exception (queued)', { torName: payload.torName, message: msg, ...(tranCode ? { tranCode } : {}) });
      postQueue.enqueue({ method, url, headers, data: payload, reason: msg });
      state.onPostResult({ ok: false, queued: true });
      state.setPostQueueSize(postQueue.size());
    }
  });

  if (mode === 'tcp') {
    logger.infoMeta('Starting TCP client', { ip: targetIp, port: targetPort, config: cfgPath });

    const rcfg = {
      baseDelayMs: cfg.decoder?.reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: cfg.decoder?.reconnect?.maxDelayMs ?? 30000,
      backoffFactor: cfg.decoder?.reconnect?.backoffFactor ?? 1.8,
      jitterRatio: cfg.decoder?.reconnect?.jitterRatio ?? 0.2,
      connectTimeoutMs: cfg.decoder?.reconnect?.connectTimeoutMs ?? (cfg.defaults?.connectTimeoutMs ?? 8000),
    };

    let attempt = 0;

    const cleanupSocket = () => {
      if (!tcpSocket) return;
      try { tcpSocket.removeAllListeners(); } catch (_) {}
      try { tcpSocket.destroy(); } catch (_) {}
      tcpSocket = null;
    };

    const computeDelayMs = () => {
      // attempt starts at 1 for first retry
      const exp = Math.max(0, attempt - 1);
      let delay = rcfg.baseDelayMs * Math.pow(rcfg.backoffFactor, exp);
      delay = Math.min(delay, rcfg.maxDelayMs);
      const jitter = delay * rcfg.jitterRatio;
      // jitter in range [-jitter, +jitter]
      delay = delay + (Math.random() * 2 - 1) * jitter;
      return Math.max(0, Math.round(delay));
    };

    const scheduleReconnect = (reason) => {
      if (stopping) return;
      attempt += 1;
      const delayMs = computeDelayMs();
      state.onTcpReconnectScheduled(attempt);
      logger.warnMeta('TCP reconnect scheduled', { ip: targetIp, port: targetPort, attempt, delayMs, reason });
      if (tcpReconnectTimer) clearTimeout(tcpReconnectTimer);
      tcpReconnectTimer = setTimeout(connectOnce, delayMs);
    };

    const connectOnce = () => {
      if (stopping) return;
      if (tcpReconnectTimer) { clearTimeout(tcpReconnectTimer); tcpReconnectTimer = null; }

      cleanupSocket();

      logger.infoMeta('TCP connecting', { ip: targetIp, port: targetPort, attempt });
      tcpSocket = net.createConnection({ host: targetIp, port: targetPort });

      tcpSocket.setNoDelay(true);

      // connect timeout
      const t = setTimeout(() => {
        if (!tcpSocket) return;
        logger.warnMeta('TCP connect timeout', { ip: targetIp, port: targetPort, timeoutMs: rcfg.connectTimeoutMs });
        try { tcpSocket.destroy(new Error('connect timeout')); } catch (_) {}
      }, rcfg.connectTimeoutMs);

      tcpSocket.on('connect', () => {
        clearTimeout(t);
        attempt = 0;
        state.onTcpConnect();
        logger.info('TCP connected');
      });

      tcpSocket.on('data', (chunk) => decoder.push(chunk));

      tcpSocket.on('error', (err) => {
        // keep running; close will trigger reconnect if needed
        logger.errorMeta('TCP error', { message: err.message, code: err.code });
      });

      tcpSocket.on('close', (hadError) => {
        clearTimeout(t);
        state.onTcpDisconnect();
        logger.warnMeta('TCP connection closed', { hadError });
        scheduleReconnect('close');
      });
    };

    process.on('SIGINT', () => {
      stopping = true;
      if (tcpReconnectTimer) clearTimeout(tcpReconnectTimer);
      cleanupSocket();
      logger.info('Shutting down (SIGINT)');
      process.exit(0);
    });

    connectOnce();

  } else {
    logger.infoMeta('Starting UDP listener', { ip: targetIp, port: targetPort, config: cfgPath });
    udpSocket = dgram.createSocket('udp4');
    udpSocket.on('message', (msg) => decoder.push(msg));
    udpSocket.on('listening', () => logger.infoMeta('UDP listening', udpSocket.address()));
    udpSocket.on('error', (err) => logger.errorMeta('UDP error', { message: err.message }));
    udpSocket.bind(targetPort, targetIp);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
