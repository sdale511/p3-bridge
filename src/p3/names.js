
function toCamelCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w, i) => i === 0 ? w.toLowerCase() : (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

// TOR names from the P3 protocol tables
const TOR = {
  0x0000: 'Reset',
  0x0001: 'Passing',
  0x0002: 'Status',
  0x0003: 'Version',
  0x0004: 'Resend passings',
  0x0005: 'Clear passings',
  0x0012: 'Timing setting',
  0x0013: 'Server settings',
  0x0015: 'Session',
  0x0016: 'Network settings',
  0x0018: 'Watchdog',
  0x001C: 'Unlock functions',
  0x0020: 'Ping',
  0x0024: 'Get time',
  0x0028: 'General settings',
  0x002D: 'Signals',
  0x002F: 'Loop trigger',
  0x0030: 'GPS info',
  0xFFFF: 'Error'
};

// General fields (appear in multiple TORs)
const GENERAL_TOF = {
  0x81: 'Dec. ID',
  0x82: 'Controller ID',
  0x83: 'Request ID'
};

const TOF_BY_TOR = {
  0x0001: {
    0x01: 'Passing number',
    0x03: 'Transponder',
    0x04: 'RTC Time',
    0x05: 'Strength',
    0x06: 'Hits',
    0x08: 'Flags',
    0x0A: 'Tran Code',
    0x0E: 'User Flags',
    0x0F: 'Driver ID',
    0x10: 'UTC Time',
    0x13: 'RTC ID',
    0x14: 'Sport',
    0x30: 'Voltage',
    0x31: 'Temperature',
    0x40: 'Car Id'
  },
  0x0002: {
    0x01: 'Noise',
    0x06: 'GPS',
    0x07: 'Temperature',
    0x0A: 'SatInUse',
    0x0B: 'Loop triggers',
    0x0C: 'Input Voltage'
  },
  0x0003: {
    0x01: 'Decoder type',
    0x02: 'Description',
    0x03: 'Version',
    0x04: 'Release',
    0x08: 'Registration',
    0x0A: 'Build number',
    0x0C: 'Options'
  },
  0x0024: {
    0x01: 'RTC Time',
    0x04: 'Flags',
    0x05: 'UTC Time'
  },
  0xFFFF: {
    0x01: 'Code',
    0x02: 'Description'
  }
};

function torNameCamelCase(tor) {
  const name = TOR[tor] || `Tor 0x${tor.toString(16).padStart(4,'0')}`;
  return toCamelCase(name);
}

function tofNameCamelCase(tor, tof) {
  const table = TOF_BY_TOR[tor] || {};
  const name = table[tof] || GENERAL_TOF[tof] || `Tof 0x${tof.toString(16).padStart(2,'0')}`;
  return toCamelCase(name);
}

module.exports = { torNameCamelCase, tofNameCamelCase, toCamelCase };
