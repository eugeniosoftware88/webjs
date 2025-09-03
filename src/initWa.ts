import { WASocket, BaileysEventMap } from "baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { promises as fs } from "fs";
import path from "path";
import { Server as SocketIOServer } from "socket.io";

import {
  SESSION_FOLDER,
  WA_LOG_LEVEL,
  PAIR_PHONE,
  LOG_CONN_VERBOSE,
  MAX_RECONNECT_DELAY,
} from "./config";
import {
  logInfo,
  logError,
  logConnectionUpdateFase,
  getLogger,
  PinoLoggerOptions,
} from "./logger";
import {
  scheduleAutoPair,
  schedulePairingRefresh,
  resetPairingState,
  getAutoPairAttempts,
  resetAutoPairAttempts,
} from "./pairing";
import {
  enhanceSocketWithMessageLogging,
  alreadyLogged,
  isDirectJid,
  extractTextContent,
  logSimple,
  outboundMessages,
  jidToNumber,
  sanitizeText,
} from "./message";
import { trySendExternalMessage, trySendExternalStatus } from "./external";

let sock: WASocket | undefined;
let makeWASocket: any;
let fetchLatestWaWebVersion: any;
let useMultiFileAuthState: any;
let makeCacheableSignalKeyStore: any;
let jidNormalizedUser: any;
let fetchLatestBaileysVersion: any;
let DisconnectReason: any;

let started = false;
let reconnectAttempts = 0;
let restartScheduled = false;
let connectionState: string | undefined;
let starting = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let lastStartAt: number | undefined;

const waLogger = pino({
  level: WA_LOG_LEVEL,
  base: undefined,
} as PinoLoggerOptions);

type FriendlyReason = {
  chave: string;
  titulo: string;
  sugestao?: string;
};

const DISCONNECT_REASONS: Record<number, FriendlyReason> = {
  401: {
    chave: "loggedOut",
    titulo: "Sessao encerrada ou invalidada (logged out)",
    sugestao:
      "Remover pasta de sessao e gerar novo cadigo de pareamento /baileys/pair",
  },
  403: {
    chave: "forbidden",
    titulo: "Acesso negado (forbidden)",
    sugestao:
      "Verifique se a conta nao esta bloqueada ou com restriçaes no WhatsApp",
  },
  408: {
    chave: "connectionLost|timedOut",
    titulo: "Conexao perdida ou tempo excedido (timeout)",
    sugestao: "Verificar conectividade de rede e latência",
  },
  411: {
    chave: "multideviceMismatch",
    titulo: "Incompatibilidade de multi-dispositivo",
    sugestao:
      "Atualize a versao do Baileys ou refaça o pareamento em ambiente atualizado",
  },
  428: {
    chave: "connectionClosed",
    titulo: "Conexao fechada pelo servidor",
    sugestao: "Tentara reconectar automaticamente",
  },
  440: {
    chave: "connectionReplaced",
    titulo: "Sessao substituada por outra conexao",
    sugestao: "Verifique se outra instância esta usando as mesmas credenciais",
  },
  500: {
    chave: "badSession",
    titulo: "Sessao corrompida ou invalida",
    sugestao: "Apagar pasta de sessao e parear novamente",
  },
  503: {
    chave: "unavailableService",
    titulo: "Serviço temporariamente indisponavel",
    sugestao: "Aguardar alguns segundos e permitir retentativa",
  },
  515: {
    chave: "restartRequired",
    titulo: "Reinicio requerido pelo servidor",
    sugestao: "Fluxo acionara Reinicio automatico",
  },
};

function friendlyDisconnect(statusCode?: number, rawMessage?: string) {
  if (!statusCode) {
    return {
      codigo: statusCode,
      chave: "desconhecido",
      titulo: "Motivo de desconexao desconhecido",
      sugestao: "Consultar logs detalhados e stack trace",
      rawMessage,
    };
  }
  const base = DISCONNECT_REASONS[statusCode];
  if (!base) {
    return {
      codigo: statusCode,
      chave: "naoMapeado",
      titulo: `Cadigo de desconexao nao mapeado (${statusCode})`,
      sugestao: "Verificar documentaçao do Baileys ou atualizar mapeamento",
      rawMessage,
    };
  }
  return { codigo: statusCode, ...base, rawMessage };
}

function calcDelay() {
  const base = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  return base + Math.floor(Math.random() * 1000);
}

async function ensureBaileysLoaded() {
  if (makeWASocket) return;
  const m = await import("baileys");
  makeWASocket = m.default;
  fetchLatestWaWebVersion = m.fetchLatestWaWebVersion;
  useMultiFileAuthState = m.useMultiFileAuthState;
  makeCacheableSignalKeyStore = m.makeCacheableSignalKeyStore;
  jidNormalizedUser = m.jidNormalizedUser;
  fetchLatestBaileysVersion = m.fetchLatestBaileysVersion;
  DisconnectReason = m.DisconnectReason;
}

async function maybePurgeStaleSession() {
  try {
    const sessionDir = path.resolve(SESSION_FOLDER);
    const credsFile = path.join(sessionDir, "creds.json");
    const exists = await fs.stat(credsFile).catch(() => undefined);
    if (!exists) return;
    const raw = await fs.readFile(credsFile, "utf8").catch(() => undefined);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const registered = !!parsed?.registered;
      const ageMs = Date.now() - exists.mtimeMs;
      if (!registered) {
        await fs.rm(sessionDir, { recursive: true, force: true });
        logInfo({
          evento: "session.purge.preStart",
          motivo: "unregistered",
          ageMs,
        });
      } else {
        logInfo({
          evento: "session.purge.skip",
          motivo: "registered",
          ageMs,
        });
      }
    } catch (e) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      logInfo({ evento: "session.purge.preStart", motivo: "invalid_json" });
    }
  } catch (e) {
    logError({ e }, "maybePurgeStaleSession falhou");
  }
}

export function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

export function cleanupCurrentSocket(reason?: string) {
  if (!sock) return;
  try {
    const evNames = [
      "connection.update",
      "creds.update",
      "messages.upsert",
      "presence.update",
      "groups.upsert",
      "groups.update",
      "group-participants.update",
      "contacts.upsert",
      "messaging-history.set",
    ];
    for (const ev of evNames) {
      try {
        (sock as any).ev.removeAllListeners(ev);
      } catch {}
    }
  } catch {}
  try {
    (sock as any).ws?.removeAllListeners();
  } catch {}
  try {
    (sock as any).ws?.close();
  } catch {}
  try {
    sock.end(undefined);
  } catch {}
  waLogger.debug({ reason }, "Socket anterior finalizado e listeners limpos");
  sock = undefined;
}

export async function startBaileys(io: SocketIOServer) {
  if (starting) {
    waLogger.debug("startBaileys ignorado - ja em andamento");
    return;
  }
  starting = true;
  await ensureBaileysLoaded();
  lastStartAt = Date.now();
  await maybePurgeStaleSession();
  clearReconnectTimer();
  if (sock) cleanupCurrentSocket("restart_pre_start");

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
  let version: [number, number, number];

  try {
    const web = await fetchLatestWaWebVersion({});
    version = web.version;
  } catch (errPrimary) {
    const logger = getLogger();
    logger?.warn(
      { errPrimary },
      "Falha ao obter versao web; tentando versao Baileys recomendada"
    );
    try {
      const b = await fetchLatestBaileysVersion();
      version = b.version;
    } catch (errFallback) {
      logger?.error(
        { errFallback },
        "Falha tambem em fetchLatestBaileysVersion; usando versao padrao [2,3000,1026582323]"
      );
      version = [2, 3000, 1026582323];
    }
  }

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    logger: waLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, waLogger),
    },
    shouldIgnoreJid: (jid: any) => {
      if (typeof jid !== "string") return false;
      if (/@g\.us$/.test(jid)) return true;
      if (/@broadcast$/.test(jid) || jid === "status@broadcast") return true;
      if (/newsletter|channel/i.test(jid)) return true;
      return false;
    },
  });

  if (sock) {
    sock = enhanceSocketWithMessageLogging(sock, io, getJidNormalizedUser());
  }

  if (sock) sock.ev.on("creds.update", saveCreds);
  if (!state.creds.registered && PAIR_PHONE) {
    waLogger.debug("Agendando auto pairing inicial (sessao nao registrada)");
    scheduleAutoPair(sock, 2000);
  }

  if (sock)
    sock.ev.process(async (events: Partial<BaileysEventMap>) => {
      if (events["connection.update"]) {
        const update: any = events["connection.update"];
        const { connection, lastDisconnect, qr } = update;
        connectionState = connection;
        io.emit("connection_state", { state: connectionState });

        if (connection && connection !== "open" && connection !== "close") {
          logConnectionUpdateFase(
            connection,
            { info: "Estado intermediario" },
            LOG_CONN_VERBOSE
          );
        }

        if (qr) {
          logConnectionUpdateFase(
            "qr",
            {
              ignorado: true,
              motivo: "fallback_desabilitado",
            },
            LOG_CONN_VERBOSE
          );
        }

        if (connection === "open") {
          clearReconnectTimer();
          logConnectionUpdateFase(
            "open",
            { mensagem: "Conexao estabelecida" },
            LOG_CONN_VERBOSE
          );
          reconnectAttempts = 0;
          io.emit("ready", "Medicit conectado");
          const meJid =
            sock?.user?.id || sock?.authState.creds.me?.id || "desconhecido";
          let numero = meJid;
          if (numero !== "desconhecido") {
            numero = numero.split("@")[0].split(":")[0];
          }
          const logger = getLogger();
          logger?.info(`Sessao conectada com o numero ${numero}`);
          io.emit("message", "Sessao pronta.");
          resetAutoPairAttempts();
          if (sock && !sock.authState.creds.registered && PAIR_PHONE) {
            scheduleAutoPair(sock, 1500);
          }
        } else if (connection === "close") {
          const statusCode =
            lastDisconnect?.error instanceof Boom
              ? lastDisconnect.error.output.statusCode
              : undefined;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          const rawMessage = lastDisconnect?.error?.message || "";
          const friendly = friendlyDisconnect(statusCode, rawMessage);
          waLogger.warn(
            { statusCode, rawMessage, friendly },
            "Conexao fechada"
          );
          logConnectionUpdateFase(
            "close",
            {
              codigo: friendly.codigo,
              chave: friendly.chave,
              titulo: friendly.titulo,
              sugestao: friendly.sugestao,
            },
            LOG_CONN_VERBOSE
          );

          const pairingExpired = /QR refs attempts ended/i.test(rawMessage);
          if (pairingExpired) {
            const logger = getLogger();
            logger?.warn(
              "Pairing/QR expirado: gere novo codigo em /baileys/pair?phone=55DDDNUMERO"
            );
            io.emit("pairing_expired", {
              message: "Pairing/QR expirado. Gere novo codigo.",
            });
          }

          const critical =
            statusCode === DisconnectReason.badSession ||
            statusCode === DisconnectReason.forbidden ||
            statusCode === DisconnectReason.multideviceMismatch;

          if (!loggedOut && !critical) {
            reconnectAttempts++;
            const delay = calcDelay();
            const motivo = rawMessage || "desconhecido";
            const logger = getLogger();
            logger?.warn(
              {
                evento: "reconnect.schedule",
                tentativa: reconnectAttempts,
                delayMs: delay,
                statusCode,
                motivo,
                titulo: friendly.titulo,
              },
              `Conexao perdida (${motivo}). Reconectando em ${delay / 1000}s`
            );
            io.emit(
              "message",
              pairingExpired
                ? `Pairing expirado. Gerando nova sessao em ${
                    delay / 1000
                  }s (tentativa ${reconnectAttempts})`
                : `Reconectando em ${
                    delay / 1000
                  }s (tentativa ${reconnectAttempts})`
            );
            clearReconnectTimer();
            reconnectTimer = setTimeout(() => startBaileys(io), delay);
          } else {
            const wasRegistered = !!sock?.authState.creds.registered;
            const logger = getLogger();
            logger?.error(
              { wasRegistered, rawMessage, statusCode },
              "Sessao finalizada (logged out)"
            );
            const early = lastStartAt && Date.now() - lastStartAt < 7000;
            if (early) {
              resetPairingState();
            }
            io.emit(
              "message",
              wasRegistered
                ? "Sessao encerrada (logged out). Limpando e reiniciando."
                : early
                ? "Sessao invalida logo apos iniciar. Limpando e reiniciando..."
                : "Sessao nao registrada e desconectada. Reiniciando..."
            );
            if (!restartScheduled) {
              restartScheduled = true;
              (async () => {
                try {
                  cleanupCurrentSocket("logged_out_or_critical");
                  await fs.rm(path.resolve(SESSION_FOLDER), {
                    recursive: true,
                    force: true,
                  });
                } catch (e) {
                  const logger = getLogger();
                  logger?.error({ e }, "Falha ao remover pasta de sessao");
                }
                resetPairingState();
                if (early) await new Promise((r) => setTimeout(r, 1500));
                try {
                  await startBaileys(io);
                } catch (e2) {
                  const logger = getLogger();
                  logger?.error({ e2 }, "Falha ao reiniciar apos limpeza");
                } finally {
                  restartScheduled = false;
                }
              })();
            }
          }
        }
      }

      if (events["creds.update"]) await events["creds.update"];

      if (events["messages.upsert"]) {
        const { messages, type } = events["messages.upsert"] as any;
        if (type === "notify") {
          for (const msg of messages) {
            const { key, message: content, messageTimestamp } = msg;
            const { remoteJid, fromMe, id: messageId } = key;

            if (!remoteJid || alreadyLogged(messageId)) continue;
            if (!isDirectJid(remoteJid)) continue;

            const text = extractTextContent(content);
            if (!text) continue;

            const direction = fromMe ? "out" : "in";
            logSimple(direction as any, remoteJid, text);

            if (direction === "out") {
              if (messageId && outboundMessages.has(messageId)) {
                const meta = outboundMessages.get(messageId)!;
                if (!meta.status || meta.status < 2) {
                  meta.status = 2;
                  trySendExternalStatus("Recebido", remoteJid, messageId);
                }
              }
              io.emit("message_out", {
                direction: "out",
                to: remoteJid,
                text,
                id: messageId,
                ts: messageTimestamp,
              });
            } else {
              io.emit("message_in", {
                direction: "in",
                from: remoteJid,
                text,
                id: messageId,
                timestamp: messageTimestamp,
              });
            }
          }
        }
      }

      if (events["messages.update"]) {
        const updates = events["messages.update"] as any;
        for (const up of updates) {
          try {
            const { key, update } = up;
            const msgId = key?.id;
            if (!msgId) continue;
            if (!key?.fromMe) continue;

            const outMsg = outboundMessages.get(msgId);
            if (!outMsg) continue;

            const status = update?.status;
            if (
              typeof status === "number" &&
              (!outMsg.status || status > outMsg.status)
            ) {
              outMsg.status = status;
              let statusName: string;
              if (status === 1) statusName = "Enviado";
              else if (status === 2) statusName = "Recebido";
              else if (status === 3 || status === 4) statusName = "Visualizado";
              else statusName = `Status_${status}`;

              trySendExternalStatus(statusName, outMsg.to, msgId);
              io.emit("message_status", {
                id: msgId,
                status,
                statusName,
                to: outMsg.to,
              });
            }
          } catch {}
        }
      }
    });

  starting = false;
}

export async function resetSession(io: SocketIOServer) {
  try {
    cleanupCurrentSocket("manual_reset");
    await fs.rm(path.resolve(SESSION_FOLDER), { recursive: true, force: true });
    resetPairingState();
    restartScheduled = true;
    setTimeout(async () => {
      try {
        await startBaileys(io);
        restartScheduled = false;
        if (sock && !sock.authState.creds.registered && PAIR_PHONE)
          scheduleAutoPair(sock, 1200);
      } catch (e) {
        restartScheduled = false;
        const logger = getLogger();
        logger?.error({ e }, "Falha ao reiniciar depois de reset manual");
      }
    }, 400);
    return { ok: true, message: "Sessao resetada; reiniciando." };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export function getConnectionStatus() {
  return {
    ok: true,
    connection: connectionState,
    registered: !!sock?.authState.creds.registered,
    reconnectAttempts,
    autoPairAttempts: getAutoPairAttempts(),
    restartScheduled,
  };
}

export function getSocket(): WASocket | undefined {
  return sock;
}

export function isStarted(): boolean {
  return started;
}

export function setStarted(value: boolean) {
  started = value;
}

export function getJidNormalizedUser() {
  return jidNormalizedUser;
}

export { jidNormalizedUser };
