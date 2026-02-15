function createState() {
  const startedAt = Date.now();

  const s = {
    startedAt,
    mode: null,
    ip: null,
    port: null,

    tcpConnected: false,
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
    lastPostAt: null
  };

  function incMap(map, key) {
    const k = (key || 'unknown').toString();
    map[k] = (map[k] || 0) + 1;
  }

  return {
    setBase({ mode, ip, port }) {
      s.mode = mode;
      s.ip = ip;
      s.port = port;
    },
    onTcpConnect() {
      s.tcpConnected = true;
      s.tcpLastConnectAt = new Date().toISOString();
    },
    onTcpDisconnect() {
      s.tcpConnected = false;
      s.tcpLastDisconnectAt = new Date().toISOString();
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
    snapshot() {
      return {
        ...s,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
      };
    }
  };
}

module.exports = { createState };
