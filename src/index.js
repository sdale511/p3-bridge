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

function pickPort(mode, cfg, cliPort) {
  if (cliPort) return cliPort;
  if (mode === 'udp') return cfg.defaults?.udpListenPort ?? 5303;
  return cfg.defaults?.tcpPort ?? 5403;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .scriptName('p3-bridge')
    .usage('$0 <ip> [port] [options]')
    .positional('ip', { describe: 'Decoder IP (TCP) or bind IP (UDP)', type: 'string' })
    .positional('port', { describe: 'TCP port (connect) or UDP port (listen)', type: 'number' })
    .option('mode', { choices: ['tcp', 'udp'], default: undefined, describe: 'Transport mode' })
    .option('tcp', { type: 'boolean', describe: 'Force TCP mode' })
    .option('udp', { type: 'boolean', describe: 'Force UDP mode' })
    .option('config', { type: 'string', describe: 'Path to config json' })
    .option('no-post', { type: 'boolean', default: false, describe: 'Disable HTTPS posting (dry-run)' })
    .option('no-console-log', { type: 'boolean', default: false, describe: 'Disable console logging' })
    .option('no-file-log', { type: 'boolean', default: false, describe: 'Disable general rotating file log' })
    .option('no-http-log', { type: 'boolean', default: false, describe: 'Disable HTTP rotating file log' })
    .option('no-json-log', { type: 'boolean', default: false, describe: 'Disable JSON payload rotating file log' })
    .option('suppress-status', { type: 'boolean', default: false, describe: 'Suppress Status TOR records from logs/JSON/POST' })
    .option('debug', { type: 'boolean', default: false, describe: 'Verbose logging' })
    .demandCommand(1)
    .help()
    .argv;

  const { cfg, path: cfgPath } = loadConfig(argv.config);

  const mode = argv.mode || (argv.udp ? 'udp' : (argv.tcp ? 'tcp' : (cfg.defaults?.mode || 'tcp')));
  const ip = argv._[0];
  const port = pickPort(mode, cfg, argv._[1] ? Number(argv._[1]) : undefined);

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
    if (postQueue.size() > 0) {
      logger.warnMeta('Loaded queued POST errors', { count: postQueue.size(), file: 'post-errors-queue.json' });
    }
    postQueue.start();
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
      logger.warnMeta('P3 parse error', parsed);
      return;
    }

    // Optionally suppress status records entirely
    if (suppressStatus && isStatusRecord(parsed)) {
      if (argv.debug) {
        logger.debugMeta('Suppressed status record', {
          tor: `0x${parsed.tor.toString(16).padStart(4, '0')}`,
          decoderId: parsed.fields?.find(f => f?.tofName === 'decoderId')?.value
        });
      }
      return;
    }

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
      } else {
        logger.infoMeta('Posted record', { torName: payload.torName, status: res.status, ...(tranCode ? { tranCode } : {}) });
        // On success, try to replay any queued errors immediately.
        void postQueue.drain('onSuccess');
      }
    } catch (e) {
      // Network / TLS / timeout errors after retries. Do NOT crash the server.
      const msg = e?.message || 'post exception';
      logger.errorMeta('Post exception (queued)', { torName: payload.torName, message: msg, ...(tranCode ? { tranCode } : {}) });
      postQueue.enqueue({ method, url, headers, data: payload, reason: msg });
    }
  });

  if (mode === 'tcp') {
    logger.infoMeta('Starting TCP client', { ip, port, config: cfgPath });

    const socket = net.createConnection({ host: ip, port }, () => {
      logger.info('TCP connected');
    });

    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('close', () => logger.warn('TCP connection closed'));
    socket.on('error', (err) => logger.errorMeta('TCP error', { message: err.message }));

  } else {
    logger.infoMeta('Starting UDP listener', { ip, port, config: cfgPath });
    const s = dgram.createSocket('udp4');
    s.on('message', (msg) => decoder.push(msg));
    s.on('listening', () => logger.infoMeta('UDP listening', s.address()));
    s.on('error', (err) => logger.errorMeta('UDP error', { message: err.message }));
    s.bind(port, ip);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
