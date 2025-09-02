import pino, { LoggerOptions, LevelWithSilent } from "pino";

export default async function createLogger(level: LevelWithSilent = "info") {
  const isProd = process.env.NODE_ENV === "production";
  let transport: LoggerOptions["transport"];
  if (!isProd) {
    try {
      const { createRequire } = await import("module");
      const req = createRequire(process.cwd() + "/");
      req.resolve("pino-pretty");
      transport = {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      };
    } catch (e) {
      transport = undefined;
    }
  }
  return pino({
    level,
    base: undefined,
    redact: ["req.headers.authorization"],
    transport,
  });
}
