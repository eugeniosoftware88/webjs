import { promises as fs } from "fs";
import path from "path";
import http from "http";
import { SESSION_FOLDER } from "./config";
import { logInfo, logError } from "./logger";
import {
  cleanupCurrentSocket,
  clearReconnectTimer,
  getConnectionStatus,
} from "./initWa";

let shuttingDown = false;

export async function gracefulShutdown(
  server: http.Server,
  reason: string,
  exitCode = 0
) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    logInfo({ evento: "shutdown.start", reason });
    clearReconnectTimer();

    const status = getConnectionStatus();
    const connected = status.connection === "open" && status.registered;

    if (!connected) {
      try {
        cleanupCurrentSocket("graceful_shutdown");
      } catch {}
      try {
        await fs.rm(path.resolve(SESSION_FOLDER), {
          recursive: true,
          force: true,
        });
        logInfo("Pasta de sessão removida no desligamento");
      } catch (e) {
        logError("Falha ao remover pasta sessão no desligamento", e);
      }
    } else {
      try {
        cleanupCurrentSocket("graceful_shutdown_preserve_session");
      } catch {}
      logInfo("Sessão preservada para próximo start (conectada)");
    }

    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
        setTimeout(() => resolve(), 6000);
      } catch {
        resolve();
      }
    });

    logInfo({ evento: "shutdown.completed", reason });
  } catch (err) {
    logError("Erro durante graceful shutdown", err);
  } finally {
    process.exit(exitCode);
  }
}

export function bindProcessSignals(server: http.Server) {
  const signals: NodeJS.Signals[] = [
    "SIGINT",
    "SIGTERM",
    "SIGUSR2",
    "SIGBREAK",
  ];

  for (const sig of signals) {
    try {
      process.on(sig, () => gracefulShutdown(server, sig, 0));
    } catch {}
  }

  try {
    process.on("message", (msg: any) => {
      if (msg === "SIGINT" || msg === "shutdown")
        gracefulShutdown(server, "message:" + msg, 0);
    });
  } catch {}

  process.on("uncaughtException", (err) => {
    logError({ err }, "uncaughtException");
    gracefulShutdown(server, "uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason: any) => {
    logError({ reason }, "unhandledRejection");
    gracefulShutdown(server, "unhandledRejection", 1);
  });

  setTimeout(() => {
    if (!shuttingDown) return;
    logError(
      { aviso: "Forcando encerramento apos timeout" },
      "shutdown.timeout"
    );
    process.exit(1);
  }, 15000).unref();
}
