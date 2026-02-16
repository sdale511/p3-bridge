# p3-bridge

A small Node.js bridge that connects to a MYLAPS P3 decoder over **TCP** (default) or listens for **UDP**, decodes P3 records, converts them to JSON, and optionally HTTPS POSTs them.

## Install

```bash
cp config.example.json config.json
npm install
```

## Run

You can pass the decoder IP/port on the command line, **or** set defaults in `config.json` so no CLI args are required.

TCP (decoder is server, default P3 port 5403):

```bash
node src/index.js 192.168.1.89
# or override port
node src/index.js 192.168.1.89 5403
```

UDP listen (default 5303):

```

Use config defaults (no command line args):

```bash
node src/index.js
```

`config.json` example:
```json
{
  "defaults": { "mode": "tcp", "tcpHost": "192.168.1.89", "tcpPort": 5403 }
}
```

bash
node src/index.js 0.0.0.0 5303 --udp
```

Dry-run (no HTTPS posting):

```bash
node src/index.js 192.168.1.89 --no-post
```

Suppress Status TOR records (TOR 0x0002) from console/file logs, JSON log, and HTTPS POST:

```bash
node src/index.js 192.168.1.89 --suppress-status
```

## Timer webhook

p3-bridge can send a small periodic HTTP POST to your race control server so it can keep accurate time and end races even if no web page is open.

- Sends JSON: `{ "utc": <milliseconds since epoch UTC> }`
- Runs on an interval (default **30 seconds**)
- Uses a **separate** `timer.baseUrl` + `timer.path`
- `timer.path` should end with `timerWebhook`

Enable/configure in `config.json`:

```json
{
  "timer": {
    "enabled": true,
    "baseUrl": "https://example.com",
    "path": "/api/timerWebhook",
    "intervalSec": 30
  }
}
```

Disable from the command line:

```bash
node src/index.js --no-timer
```

## Logs

Logs are written to `./logs` by default:
- `p3-YYYY-MM-DD.log` (general)
- `p3-http-YYYY-MM-DD.log` (HTTP)
- `p3-json-YYYY-MM-DD.log` (JSON payloads)

Disable logs with:
- `--no-file-log`
- `--no-http-log`
- `--no-json-log`
- `--no-console-log`

## Admin UI

p3-bridge includes a lightweight **local** admin web interface (simple HTML + JSON API).

### HTML UI

Open in a browser on the same network:

- `http://<pi-ip>:8080/admin`

The page auto-refreshes every 2 seconds and shows:

- uptime + mode + target ip:port
- TCP connected / UDP listening state
- message counters (total/ok/parseErr/suppressed)
- post counters (ok/fail/queued + queue size)
- buttons to restart and apply a JSON patch to settings

### JSON API

All endpoints are served from the same admin listener (default `0.0.0.0:8080`).

If `admin.token` is set, **every** request must include either:

- `Authorization: Bearer <token>` **or**
- `X-Admin-Token: <token>`

#### `GET /healthz`

Basic liveness probe.

Response:
```json
{ "ok": true, "at": "2026-02-15T12:34:56.789Z" }
```

#### `GET /admin/api/status`

Returns current runtime state and counters.

Response (example):
```json
{
  "ok": true,
  "at": "2026-02-15T12:34:56.789Z",
  "cfgPath": "/home/jycadmin/p3-bridge/config.json",
  "state": {
    "uptimeSec": 123,
    "mode": "tcp",
    "ip": "192.168.1.89",
    "port": 5403,
    "tcpConnected": true,
    "msgTotal": 1000,
    "msgOk": 995,
    "msgParseErr": 5,
    "msgSuppressed": 120,
    "postOk": 200,
    "postFail": 3,
    "postQueued": 7,
    "postQueueSize": 2
  }
}
```

#### `GET /admin/api/settings`

Returns the currently loaded config sections that the admin UI cares about.

Response:
```json
{
  "ok": true,
  "at": "2026-02-15T12:34:56.789Z",
  "cfgPath": "/home/jycadmin/p3-bridge/config.json",
  "settings": {
    "admin": { "enabled": true, "host": "0.0.0.0", "port": 8080, "token": null },
    "post": { "...": "..." },
    "logging": { "...": "..." },
    "defaults": { "...": "..." },
    "decoder": { "...": "..." }
  }
}
```

#### `PUT /admin/api/settings?restart=true|false`

Applies a **JSON patch** to a **safe allowlist** of fields in `config.json`.

- Writes `config.json` **atomically** (temp file + rename)
- By default, triggers a restart (`restart=true` is the default)
- To apply without restart: `?restart=false`

Request body (example):
```json
{
  "post": { "enabled": true, "baseUrl": "https://example.com" },
  "logging": { "suppressStatus": true }
}
```

Response:
```json
{ "ok": true, "applied": ["post.enabled","post.baseUrl","logging.suppressStatus"], "rejected": [], "restart": true }
```

Allowed fields (current allowlist):

- `admin.enabled`, `admin.host`, `admin.port`, `admin.token`
- `post.enabled`, `post.baseUrl`, `post.path`, `post.method`, `post.timeoutMs`,
  `post.retries`, `post.retryDelayMs`, `post.retryBackoffMultiplier`, `post.queueDrainMaxPerTick`
- `logging.dir`, `logging.suppressStatus`
- `defaults.mode`, `defaults.tcpPort`, `defaults.udpListenPort`, `defaults.connectTimeoutMs`
- `decoder.reconnect.baseDelayMs`, `decoder.reconnect.maxDelayMs`,
  `decoder.reconnect.backoffFactor`, `decoder.reconnect.jitterRatio`, `decoder.reconnect.connectTimeoutMs`

Any other fields are rejected (they will appear in `rejected`).

#### `POST /admin/api/restart`

Requests a process restart.

Response:
```json
{ "ok": true, "at": "2026-02-15T12:34:56.789Z", "restarting": true }
```

> **Note:** restart is implemented as a clean process exit. If you run p3-bridge under **systemd** with `Restart=always`, it will come right back up.


#### `PUT /admin/api/target`

Update the **current** TCP decoder target (IP + port). This is what the HTML UI uses for the “Target” controls.

- By default this updates the in-memory target immediately (forces a TCP reconnect).
- If `persist=true`, it also writes `defaults.tcpHost` and `defaults.tcpPort` into `config.json`.
- If `restart=true`, it triggers a graceful process exit so **systemd** can restart the service.

Query params:
- `persist=true|false` (optional)
- `restart=true|false` (optional)

Body:
```json
{ "ip": "192.168.1.50", "port": 5403 }
```

Example (set + reconnect, no restart):
```bash
curl -X PUT http://<pi-ip>:8080/admin/api/target \
  -H 'Content-Type: application/json' \
  -d '{ "ip": "192.168.1.50", "port": 5403 }'
```

Example (save to config + restart):
```bash
curl -X PUT 'http://<pi-ip>:8080/admin/api/target?persist=true&restart=true' \
  -H 'Content-Type: application/json' \
  -d '{ "ip": "192.168.1.50", "port": 5403 }'
```

#### `GET /admin/api/log/tail`

Tail the newest rotating log file for a given log stream.

Query params:
- `name=main|http|json|post-errors`
- `lines=10..1000` (default 200)

Response: `text/plain`

Example:
```bash
curl 'http://<pi-ip>:8080/admin/api/log/tail?name=main&lines=200'
```

### Notes

- The HTML UI includes a simple “Logs” panel that uses `/admin/api/log/tail` to show recent log lines.
- The “Restart” button (and `POST /admin/api/restart`) exits the process; ensure your systemd unit has `Restart=always`.
