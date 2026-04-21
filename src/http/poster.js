
const axios = require('axios');
const https = require('https');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildUrl(baseUrl, p) {
  if (!baseUrl) throw new Error('post.baseUrl missing');
  const b = baseUrl.replace(/\/$/, '');
  const pathPart = (p || '').startsWith('/') ? p : `/${p || ''}`;
  return b + pathPart;
}

async function postWithRetries({ logger, httpLogger, method, url, data, headers, timeoutMs, retries, retryDelayMs, retryBackoffMultiplier, maxRetryDelayMs, beforeAttempt, onRetry }) {
  const agent = new https.Agent({ keepAlive: true });
  const queuePacedRetries = typeof beforeAttempt === 'function';

  let attempt = 0;
  let delay = Math.max(1, Number(retryDelayMs) || 1);
  const maxDelay = Math.max(delay, Number(maxRetryDelayMs) || delay);
  while (true) {
    attempt++;
    let retryMeta = null;
    try {
      await beforeAttempt?.({ attempt, method, url });
      httpLogger?.infoMeta('HTTP request', { method, url, attempt, headers, body: data });
      const resp = await axios.request({
        method,
        url,
        data,
        headers,
        timeout: timeoutMs,
        httpsAgent: agent,
        validateStatus: () => true
      });

      httpLogger?.infoMeta('HTTP response', { status: resp.status, statusText: resp.statusText, data: resp.data });

      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true, status: resp.status, data: resp.data };
      }

      // retry on 429, 5xx; otherwise fail fast
      const retryable = (resp.status === 429) || (resp.status >= 500 && resp.status <= 599);
      if (!retryable || attempt > retries) {
        return { ok: false, status: resp.status, data: resp.data };
      }

      retryMeta = {
        kind: 'response',
        status: resp.status,
        statusText: resp.statusText
      };
    } catch (err) {
      httpLogger?.errorMeta('HTTP error', { attempt, message: err.message });
      if (attempt > retries) {
        throw err;
      }

      retryMeta = {
        kind: 'error',
        message: err.message,
        code: err.code
      };
    }

    const waitMsRaw = queuePacedRetries ? 0 : delay;
    const waitMs = Math.max(0, Number(waitMsRaw) || 0);
    const retryInfo = {
      attempt,
      nextAttempt: attempt + 1,
      delayMs: waitMs,
      retryReason: retryMeta?.kind || 'unknown',
      ...(retryMeta?.status != null ? { status: retryMeta.status, statusText: retryMeta.statusText } : {}),
      ...(retryMeta?.message ? { message: retryMeta.message } : {}),
      ...(retryMeta?.code ? { code: retryMeta.code } : {}),
      ...(queuePacedRetries ? { queuedByRateLimiter: true } : {}),
      ...(retryMeta?.kind === 'error' ? { networkError: true } : {})
    };
    try { onRetry?.(retryInfo); } catch (_) {}
    logger?.warnMeta('Retrying post', retryInfo);
    if (waitMs > 0) await sleep(waitMs);
    if (!queuePacedRetries) {
      delay = Math.min(maxDelay, Math.max(1, Math.floor(Math.max(waitMs, 1) * retryBackoffMultiplier)));
    }
  }
}

module.exports = { buildUrl, postWithRetries };
