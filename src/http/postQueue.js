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
  constructor({ filePath, errorLogger, intervalMs = 30_000, drainMaxPerTick = 5, postFn, onChange, onEntryResult }) {
    this.filePath = filePath;
    this.errorLogger = errorLogger;
    this.intervalMs = intervalMs;
    this.drainMaxPerTick = drainMaxPerTick;
    this.postFn = postFn;
    this.onChange = onChange;
    this.onEntryResult = onEntryResult;
    this.queue = safeReadJson(filePath);
    this._running = false;
    this._draining = false;
    this._kickScheduled = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._notifyChange();
    this._schedule('start');
  }

  stop() {
    this._running = false;
    this._kickScheduled = false;
  }

  size() {
    return this.queue.length;
  }

  persist() {
    atomicWrite(this.filePath, JSON.stringify(this.queue, null, 2));
  }

  _notifyChange() {
    try { this.onChange?.(this.queue.length); } catch (_) {}
  }

  _schedule(trigger = 'manual') {
    if (!this._running || this._draining || this._kickScheduled || !this.queue.length) return;
    this._kickScheduled = true;
    setTimeout(() => {
      this._kickScheduled = false;
      void this.drain(trigger);
    }, 0).unref?.();
  }

  enqueue({ method, url, headers, data, reason, eventId }) {
    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      eventId: eventId || null,
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
    this._notifyChange();
    this._schedule('enqueue');

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
    if (this._draining || !this._running || !this.queue.length) return;

    this._draining = true;
    try {
      const entry = this.queue[0];
      entry.lastTriedAt = new Date().toISOString();
      entry.attempts = (entry.attempts || 0) + 1;

      try {
        const res = await this.postFn(entry);
        if (res?.ok) {
          try { this.onEntryResult?.(entry, { ok: true, status: res.status, queued: false }); } catch (_) {}
          this.errorLogger?.infoMeta('Replayed queued POST', {
            trigger,
            id: entry.id,
            status: res.status,
            torName: entry.data?.torName,
            tranCode: entry.data?.decoded?.tranCode
          });
          this.queue.shift();
          this.persist();
          this._notifyChange();
        } else {
          entry.lastError = `HTTP ${res?.status ?? 'unknown'}`;
          this.queue.push(this.queue.shift());
          this.persist();
          try { this.onEntryResult?.(entry, { ok: false, status: res?.status, queued: true }); } catch (_) {}
          this.errorLogger?.warnMeta('Queued POST requeued', {
            trigger,
            id: entry.id,
            status: res?.status,
            torName: entry.data?.torName,
            tranCode: entry.data?.decoded?.tranCode
          });
        }
      } catch (e) {
        entry.lastError = e?.message || 'post exception';
        this.queue.push(this.queue.shift());
        this.persist();
        try { this.onEntryResult?.(entry, { ok: false, queued: true, error: entry.lastError }); } catch (_) {}
        this.errorLogger?.warnMeta('Queued POST exception requeued', {
          trigger,
          id: entry.id,
          message: entry.lastError,
          torName: entry.data?.torName,
          tranCode: entry.data?.decoded?.tranCode
        });
      }
    } finally {
      this._draining = false;
      this._schedule('continue');
    }
  }
}

module.exports = { PostQueue };
