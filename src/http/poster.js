
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

async function postWithRetries({ logger, httpLogger, method, url, data, headers, timeoutMs, retries, retryDelayMs, retryBackoffMultiplier }) {
  const agent = new https.Agent({ keepAlive: true });

  let attempt = 0;
  let delay = retryDelayMs;
  while (true) {
    attempt++;
    try {
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
    } catch (err) {
      httpLogger?.errorMeta('HTTP error', { attempt, message: err.message });
      if (attempt > retries) {
        throw err;
      }
    }

    logger?.warnMeta('Retrying post', { attempt, delayMs: delay });
    await sleep(delay);
    delay = Math.floor(delay * retryBackoffMultiplier);
  }
}

module.exports = { buildUrl, postWithRetries };
