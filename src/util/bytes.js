
function toHex(buf) {
  return Buffer.from(buf).toString('hex').match(/.{1,2}/g)?.join(' ') || '';
}

function readUIntLE(buf) {
  if (!buf || buf.length === 0) return 0;
  let v = 0;
  for (let i = 0; i < buf.length; i++) v |= (buf[i] << (8*i));
  // NOTE: JS number; safe up to 6 bytes-ish but we also store as hex for long values
  return v >>> 0;
}

function isMostlyPrintable(buf) {
  let ok = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13) ok++;
    else if (b >= 32 && b <= 126) ok++;
  }
  return (buf.length > 0) && (ok / buf.length) > 0.85;
}

module.exports = { toHex, readUIntLE, isMostlyPrintable };
