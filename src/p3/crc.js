// CRC16 per MYLAPS P3 reference (Appendix A): poly 0x1021, init 0xFFFF, no final xor.
// Implementation matches the table-based C code from the spec.

function buildTable() {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = (i << 8) & 0xFFFF;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
    }
    table[i] = crc & 0xFFFF;
  }
  return table;
}

const CRC16_TABLE = buildTable();

function crc16Ccitt(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] & 0xFF;
    const idx = ((crc >> 8) & 0xFF);
    crc = (CRC16_TABLE[idx] ^ ((crc << 8) & 0xFFFF) ^ b) & 0xFFFF;
  }
  return crc & 0xFFFF;
}

module.exports = { crc16Ccitt };
