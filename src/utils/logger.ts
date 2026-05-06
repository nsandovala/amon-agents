/**
 * Logger simple con timestamps y niveles.
 * Respetando el principio: "Toda automatización debe dejar salida legible por humanos."
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

let currentLevel: LogLevel = "info";

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function timestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (levels[level] < levels[currentLevel]) return;
  const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
  if (meta !== undefined) {
    if (meta instanceof Error) {
      console.log(prefix, message, meta.stack ?? meta.message);
      return;
    }

    if (typeof meta === "object") {
      try {
        console.log(prefix, message, JSON.stringify(meta));
      } catch {
        console.log(prefix, message, String(meta));
      }
      return;
    }

    console.log(prefix, message, meta);
  } else {
    console.log(prefix, message);
  }
}

export function setLevel(level: LogLevel): void {
  currentLevel = level;
}

export function debug(message: string, meta?: unknown): void {
  log("debug", message, meta);
}

export function info(message: string, meta?: unknown): void {
  log("info", message, meta);
}

export function warn(message: string, meta?: unknown): void {
  log("warn", message, meta);
}

export function error(message: string, meta?: unknown): void {
  log("error", message, meta);
}
