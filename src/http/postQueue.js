const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A tiny persistent retry queue.
// Stores an array of entries in a JSON file so we can remove successfully posted items.

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const txt = fs.readFileSync(filePath, 'utf8');
    if (!txt.trim()) return [];
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function atomicWrite(filePath, contents) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

class PostQueue {
  constructor({ filePath, errorLogger, intervalMs = 30_000, drainMaxPerTick = 5, postFn }) {
    this.filePath = filePath;
    this.errorLogger = errorLogger;
    this.intervalMs = intervalMs;
    this.drainMaxPerTick = drainMaxPerTick;
    this.postFn = postFn;
    this.queue = safeReadJson(filePath);
    this._timer = null;
    this._draining = false;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      void this.drain('interval');
    }, this.intervalMs);
    // Don't keep the process alive just because of the timer.
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  size() {
    return this.queue.length;
  }

  persist() {
    atomicWrite(this.filePath, JSON.stringify(this.queue, null, 2));
  }

  enqueue({ method, url, headers, data, reason }) {
    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
      lastTriedAt: null,
      attempts: 0,
      method,
      url,
      headers,
      data,
      lastError: reason || 'post failed'
    };

    this.queue.push(entry);
    this.persist();

    // This file is both the durable queue and our "post-errors file".
    // Also write a readable log line for operators.
    this.errorLogger?.errorMeta('Queued failed POST', {
      id: entry.id,
      url: entry.url,
      method: entry.method,
      attempts: entry.attempts,
      lastError: entry.lastError,
      torName: entry.data?.torName,
      tranCode: entry.data?.decoded?.tranCode
    });

    return entry;
  }

  async drain(trigger = 'manual') {
    if (this._draining) return;
    if (!this.queue.length) return;

    this._draining = true;
    try {
      let processed = 0;
      // Work on a copy of indices; we remove as we succeed.
      while (this.queue.length && processed < this.drainMaxPerTick) {
        const entry = this.queue[0];
        entry.lastTriedAt = new Date().toISOString();
        entry.attempts = (entry.attempts || 0) + 1;

        try {
          const res = await this.postFn(entry);
          if (res?.ok) {
            this.errorLogger?.infoMeta('Replayed queued POST', {
              trigger,
              id: entry.id,
              status: res.status,
              torName: entry.data?.torName,
              tranCode: entry.data?.decoded?.tranCode
            });
            // remove entry
            this.queue.shift();
            this.persist();
            processed++;
            continue;
          }

          entry.lastError = `HTTP ${res?.status ?? 'unknown'}`;
          this.persist();
          this.errorLogger?.warnMeta('Queued POST still failing', {
            trigger,
            id: entry.id,
            status: res?.status,
            torName: entry.data?.torName,
            tranCode: entry.data?.decoded?.tranCode
          });
          // stop early to avoid hammering a down endpoint
          break;
        } catch (e) {
          entry.lastError = e?.message || 'post exception';
          this.persist();
          this.errorLogger?.warnMeta('Queued POST exception', {
            trigger,
            id: entry.id,
            message: entry.lastError,
            torName: entry.data?.torName,
            tranCode: entry.data?.decoded?.tranCode
          });
          break;
        }
      }
    } finally {
      this._draining = false;
    }
  }
}

module.exports = { PostQueue };
