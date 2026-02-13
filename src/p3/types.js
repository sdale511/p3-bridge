// Field type mapping for MYLAPS P3 protocol (v4.3.6)
// Numeric fields are little-endian ("least significant bytes first") per spec.
const TOR = {
  reset: 0x0000,
  passing: 0x0001,
  status: 0x0002,
  version: 0x0003,
  resendPassings: 0x0004,
  clearPassings: 0x0005,
  unlockFunctions: 0x001C,
  ping: 0x0020,
  getTime: 0x0024,
  generalSettings: 0x0028,
  signals: 0x002D,
  loopTrigger: 0x002F,
  gpsInfo: 0x0030,
  firstContact: 0x0045,
  timeline: 0x004A,
  error: 0xFFFF
};

// A small but practical type map covering the common TOR/TOF pairs.
// Types: u8,u16,u32,u64,i16,i32,string,bytes,bool
const TYPE_MAP = {
  // General fields (apply to all TORs)
  '*': {
    0x81: 'u32', // decoderId
    0x83: 'u32', // controllerId
    0x85: 'u64'  // requestId
  },

  [TOR.passing]: {
    0x01: 'u32', // passingNumber
    0x03: 'u32', // transponder
    0x13: 'u32', // rtcId
    0x04: 'u64', // rtcTime (µs since 1970)
    0x10: 'u64', // utcTime (µs since 1970 UTC)
    0x05: 'u16', // strength
    0x06: 'u16', // hits
    0x08: 'u16', // flags
    // Transponder "tranCode" is binary; represent as hex string in JSON
    0x0A: 'hex', // tranCode
    0x0E: 'u32', // userFlags
    0x0F: 'u8',  // driverId
    0x14: 'u8',  // sport
    0x30: 'u8',  // voltage (1/10 V)
    0x31: 'u8',  // temperature (+100 offset)
    0x40: 'u8'   // carId
  },

  [TOR.status]: {
    0x01: 'u16', // noise
    0x06: 'u8',  // gps
    0x07: 'i16', // temperature
    0x0A: 'u8',  // satInUse
    0x0B: 'u8',  // loopTriggers
    0x0C: 'u8'   // inputVoltage (1/10 V)
  },

  [TOR.version]: {
    0x01: 'u8',     // decoderType
    0x02: 'string', // description
    0x03: 'string', // version
    0x04: 'u32',    // release (seconds since 1970)
    0x08: 'u64',    // registration
    0x0A: 'u16',    // buildNumber
    0x0C: 'u32'     // options
  },

  [TOR.getTime]: {
    0x01: 'u64', // rtcTime (µs)
    0x04: 'u16', // flags
    0x05: 'u64'  // utcTime (µs)
  },

  [TOR.loopTrigger]: {
    0x01: 'string', // code
    0x02: 'u64',    // rtcTime
    0x04: 'u16',    // strength
    0x05: 'i16',    // temperature (1/10 C)
    0x06: 'u8',     // actStrength
    0x07: 'u32',    // count
    0x08: 'u64',    // utcTime
    0x09: 'u16',    // flags
    0x0A: 'u16'     // index
  },

  [TOR.gpsInfo]: {
    0x01: 'i32', // latitude (1/10000 degrees)
    0x02: 'i32', // longitude (1/10000 degrees)
    0x03: 'u8'   // satInUse
  },

  [TOR.error]: {
    0x01: 'u16',    // code
    0x02: 'string'  // description
  }
};

function getFieldType(tor, tof) {
  const t = (TYPE_MAP[tor] && TYPE_MAP[tor][tof]) || (TYPE_MAP['*'] && TYPE_MAP['*'][tof]);
  return t || null;
}

module.exports = { TOR, TYPE_MAP, getFieldType };
