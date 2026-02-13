# p3-bridge

A small Node.js bridge that connects to a MYLAPS P3 decoder over **TCP** (default) or listens for **UDP**, decodes P3 records, converts them to JSON, and optionally HTTPS POSTs them.

## Install

```bash
cp config.example.json config.json
npm install
```

## Run

TCP (decoder is server, default P3 port 5403):

```bash
node src/index.js 192.168.1.89
# or override port
node src/index.js 192.168.1.89 5403
```

UDP listen (default 5303):

```bash
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
