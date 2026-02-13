
const fs = require('fs');
const path = require('path');

function loadConfig(configPath) {
  const p = configPath || path.join(process.cwd(), 'config.json');
  const raw = fs.readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw);
  return { cfg, path: p };
}

module.exports = { loadConfig };
