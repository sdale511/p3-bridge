function createState() {
  const startedAt = Date.now();

  const s = {
    startedAt,
    mode: null,
    ip: null,
    port: null,
    targets: [],
    recentEvents: [],

    tcpConnected: false,
    tcpConnectedCount: 0,
    tcpTargetsTotal: 0,
    tcpLastConnectAt: null,
    tcpLastDisconnectAt: null,
    tcpReconnectAttempt: 0,

    msgTotal: 0,
    msgOk: 0,
    msgParseErr: 0,
    msgSuppressed: 0,
    msgCrcBad: 0,

    msgByTorName: {},

    postOk: 0,
    postFail: 0,
    postQueued: 0,
    postQueueSize: 0,

    lastMessageAt: null,
    lastPostAt: null,

    timerOk: 0,
    timerFail: 0,
    lastTimerAt: null,
    timerIntervalSec: null
  };

  function incMap(map, key) {
    const k = (key || 'unknown').toString();
    map[k] = (map[k] || 0) + 1;
  }

  function pushRecentEvent(event) {
    if (!event || typeof event !== 'object') return;
    s.recentEvents.unshift(event);
    if (s.recentEvents.length > 50) s.recentEvents.length = 50;
  }

  return {
    setBase({ mode, ip, port }) {
      s.mode = mode;
      s.ip = ip;
      s.port = port;
    },
    setTargets(targets) {
      s.targets = Array.isArray(targets)
        ? targets
          .filter((target) => target && typeof target === 'object' && target.ip)
          .map((target) => ({
            ip: String(target.ip),
            port: Number(target.port) || null,
            status: target.status || 'disconnected'
          }))
        : [];
    },
    setTargetStatus({ ip, port, status }) {
      const ipStr = ip == null ? null : String(ip);
      const portNum = Number(port) || null;
      const target = s.targets.find((item) => item.ip === ipStr && (Number(item.port) || null) === portNum);
      if (target) target.status = status || 'disconnected';
    },
    setTcpTargetsTotal(total) {
      s.tcpTargetsTotal = Math.max(0, Number(total) || 0);
    },
    onTcpConnect(target) {
      s.tcpConnectedCount += 1;
      s.tcpConnected = s.tcpConnectedCount > 0;
      s.tcpLastConnectAt = new Date().toISOString();
      if (target) s.targets.forEach((item) => {
        if (item.ip === String(target.ip) && (Number(item.port) || null) === (Number(target.port) || null)) item.status = 'connected';
      });
    },
    onTcpDisconnect(target) {
      s.tcpConnectedCount = Math.max(0, s.tcpConnectedCount - 1);
      s.tcpConnected = s.tcpConnectedCount > 0;
      s.tcpLastDisconnectAt = new Date().toISOString();
      if (target) s.targets.forEach((item) => {
        if (item.ip === String(target.ip) && (Number(item.port) || null) === (Number(target.port) || null)) item.status = 'disconnected';
      });
    },
    onTcpReconnectScheduled(attempt) {
      s.tcpReconnectAttempt = attempt;
    },
    onParseResult(parsed, { suppressed } = {}) {
      s.msgTotal += 1;
      s.lastMessageAt = new Date().toISOString();
      if (!parsed?.ok) {
        s.msgParseErr += 1;
        return;
      }
      if (suppressed) {
        s.msgSuppressed += 1;
        return;
      }
      s.msgOk += 1;
      if (parsed?.crc && parsed.crc.ok === false) s.msgCrcBad += 1;
      incMap(s.msgByTorName, parsed.torName || 'unknown');
    },
    addRecentEvent(event) {
      pushRecentEvent(event);
    },
    clearRecentEvents() {
      s.recentEvents = [];
    },
    setRecentEvents(events) {
      s.recentEvents = Array.isArray(events)
        ? events
          .filter((event) => event && typeof event === 'object')
          .slice(0, 50)
        : [];
    },
    onPostResult({ ok, queued } = {}) {
      if (ok) {
        s.postOk += 1;
        s.lastPostAt = new Date().toISOString();
      } else {
        s.postFail += 1;
      }
      if (queued) s.postQueued += 1;
    },
    setPostQueueSize(n) {
      s.postQueueSize = Number(n) || 0;
    },
    setTimerIntervalSec(n) {
      s.timerIntervalSec = Number(n) || null;
    },
    onTimerPostResult({ ok } = {}) {
      if (ok) {
        s.timerOk += 1;
        s.lastTimerAt = new Date().toISOString();
      } else {
        s.timerFail += 1;
      }
    },
    snapshot() {
      return {
        ...s,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
      };
    }
  };
}

module.exports = { createState };
