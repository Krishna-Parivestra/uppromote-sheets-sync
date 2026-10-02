import winston from "winston";
import path from "node:path";
import fs from "node:fs";

const LOG_DIR = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const SENSITIVE_KEYS = ["password", "UPPROMOTE_PASSWORD", "authorization", "cookie"];

function redact(info) {
  const clone = { ...info };
  for (const key of SENSITIVE_KEYS) {
    if (key in clone) clone[key] = "[REDACTED]";
  }
  return clone;
}

const redactFormat = winston.format((info) => redact(info))();

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    redactFormat,
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        redactFormat,
        winston.format.colorize(),
        winston.format.timestamp({ format: "HH:mm:ss" }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
          return `${timestamp} ${level} ${message}${extra}`;
        })
      ),
    }),
    new winston.transports.File({ filename: path.join(LOG_DIR, "error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(LOG_DIR, "combined.log") }),
  ],
});
