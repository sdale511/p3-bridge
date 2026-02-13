
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function makeLogger({ name, dir, filenamePrefix, enableConsole, enableFile }) {
  const transports = [];
  if (enableConsole) {
    transports.push(new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}${info.meta ? ' ' + JSON.stringify(info.meta) : ''}`)
      )
    }));
  }

  if (enableFile) {
    ensureDir(dir);
    transports.push(new DailyRotateFile({
      dirname: dir,
      filename: `${filenamePrefix}-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      zippedArchive: false,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    }));
  }

  const logger = winston.createLogger({
    level: 'info',
    defaultMeta: { logger: name },
    transports
  });

  // helper to include structured meta without messing with winston's splat
  logger.infoMeta = (msg, meta) => logger.info(msg, { meta });
  logger.warnMeta = (msg, meta) => logger.warn(msg, { meta });
  logger.errorMeta = (msg, meta) => logger.error(msg, { meta });

  return logger;
}

module.exports = { makeLogger };
