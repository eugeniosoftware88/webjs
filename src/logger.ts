import pino, {
  Logger as PinoLogger,
  LoggerOptions as PinoLoggerOptions,
  LevelWithSilent,
} from "pino";

export type { PinoLogger, PinoLoggerOptions };

type PendingLog = { level: "info" | "error"; msg: any };
const pendingLogs: PendingLog[] = [];

let logger: PinoLogger | undefined;

export default async function createLogger(
  level: LevelWithSilent = "info"
): Promise<PinoLogger> {
  const isProd = process.env.NODE_ENV === "production";
  let transport: PinoLoggerOptions["transport"];

  if (!isProd) {
    try {
      const { createRequire } = await import("module");
      const req = createRequire(process.cwd() + "/");
      req.resolve("pino-pretty");
      transport = {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
      };
    } catch (e) {
      transport = undefined;
    }
  }

  const loggerOptions: PinoLoggerOptions = {
    level,
    base: undefined,
    redact: ["req.headers.authorization"],
    transport,
  };

  logger = pino(loggerOptions);
  return logger;
}

export function getLogger(): PinoLogger | undefined {
  return logger;
}

export function logInfo(...args: any[]) {
  const msg = args.length === 1 ? args[0] : args;
  if (logger) logger.info(msg);
  else pendingLogs.push({ level: "info", msg });
}

export function logError(...args: any[]) {
  const msg = args.length === 1 ? args[0] : args;
  if (logger) logger.error(msg);
  else pendingLogs.push({ level: "error", msg });
}

export function flushPending() {
  if (!logger || !pendingLogs.length) return;
  for (const pl of pendingLogs) {
    pl.level === "error" ? logger.error(pl.msg) : logger.info(pl.msg);
  }
  pendingLogs.length = 0;
}

export function logConnectionUpdateFase(
  fase: string,
  extra?: any,
  LOG_CONN_VERBOSE?: string
) {
  const verbose = /^(true)$/i.test(
    LOG_CONN_VERBOSE || process.env.LOG_CONN_VERBOSE || "false"
  );
  const noisy = ["connecting", "syncing", "resuming", "qr"];
  if (!verbose && noisy.includes(fase)) return;
  const payload = { evento: "connection.update", fase, ...extra };
  if (logger) logger.info(payload);
  else pendingLogs.push({ level: "info", msg: payload });
}
