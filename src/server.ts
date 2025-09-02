import "dotenv/config";
import type { WASocket, BaileysEventMap } from "baileys";
import { Boom } from "@hapi/boom";
import express, { Request, Response } from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import axios from "axios";
import createLogger from "./logger";
import {
  pino as pinoLogger,
  LoggerOptions as PinoLoggerOptions,
  Logger as PinoLogger,
} from "pino";
import { promises as fs } from "fs";
import path from "path";

const APP_CONFIG = {
  PORT: parseInt(process.env.PORT || "8000", 10),
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  WA_LOG_LEVEL: process.env.WA_LOG_LEVEL || "error",
  SESSION_FOLDER: process.env.SESSION_FOLDER || "baileys_auth_info",
  PAIR_PHONE: process.env.PAIR_PHONE || "558781148453",
  LOG_WA_MESSAGES: process.env.LOG_WA_MESSAGES ?? "false",
  LOG_CONN_VERBOSE: process.env.LOG_CONN_VERBOSE ?? "false",
  EXTERNAL_ENDPOINT:
    process.env.EXTERNAL_ENDPOINT ||
    "https://app.medicit.com.br/medicit_agenda/confirm",
} as const;

const {
  PORT,
  LOG_LEVEL,
  WA_LOG_LEVEL,
  SESSION_FOLDER,
  PAIR_PHONE,
  LOG_WA_MESSAGES,
  LOG_CONN_VERBOSE,
  EXTERNAL_ENDPOINT,
} = APP_CONFIG;
const MSG_LOG_ENABLED = (() => {
  if (LOG_WA_MESSAGES == null) return true;
  if (/^(true)$/i.test(LOG_WA_MESSAGES)) return true;
  if (/^(false)$/i.test(LOG_WA_MESSAGES)) return false;
  return false;
})();
let logger: PinoLogger;
const waLogger = pinoLogger({
  level: WA_LOG_LEVEL,
  base: undefined,
} as PinoLoggerOptions);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/", express.static(process.cwd() + "/"));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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
const MAX_RECONNECT_DELAY = 60000;
let lastPairing:
  | { phone: string; code: string; at: Date; expiresAt?: Date }
  | undefined;
let pairingRefreshTimer: NodeJS.Timeout | undefined;
const PAIRING_CODE_TTL_MS = 180_000;
const PAIRING_REFRESH_LEEWAY_MS = 10_000;
const PAIRING_MIN_REUSE_REMAINING_MS = 12_000;
let autoPairAttempts = 0;
const MAX_AUTO_PAIR_ATTEMPTS = 6;
let restartScheduled = false;
let connectionState: string | undefined;
let starting = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let lastStartAt: number | undefined;
let lastPairingCodeAt: number | undefined;
const AUTO_PAIR_COOLDOWN_MS = 12_000;
const loggedMsgIds = new Set<string>();
interface OutboundMsgMeta {
  to: string;
  text?: string;
  createdAt: number;
  status?: number;
}
const outboundMessages = new Map<string, OutboundMsgMeta>();
function alreadyLogged(id?: string) {
  if (!id) return false;
  if (loggedMsgIds.has(id)) return true;
  loggedMsgIds.add(id);
  if (loggedMsgIds.size > 2000) {
    let i = 0;
    for (const mid of loggedMsgIds) {
      loggedMsgIds.delete(mid);
      if (++i >= 400) break;
    }
  }
  return false;
}

function clearPairingRefreshTimer() {
  if (pairingRefreshTimer) {
    clearTimeout(pairingRefreshTimer);
    pairingRefreshTimer = undefined;
  }
}

function isPairingCodeValid(p: typeof lastPairing | undefined) {
  if (!p) return false;
  if (!p.expiresAt) return false;
  return Date.now() < p.expiresAt.getTime();
}

function schedulePairingRefresh() {
  if (!lastPairing || !lastPairing.expiresAt) return;
  if (sock?.authState.creds.registered) return;
  clearPairingRefreshTimer();
  const remaining = lastPairing.expiresAt.getTime() - Date.now();
  if (remaining <= 0) {
    logInfo({ evento: "pairing.refresh.immediate", motivo: "expired" });
    attemptAutoPair(true);
    return;
  }
  const delay = Math.max(200, remaining - PAIRING_REFRESH_LEEWAY_MS);
  pairingRefreshTimer = setTimeout(() => {
    logInfo({ evento: "pairing.refresh.trigger", remainingBefore: remaining });
    attemptAutoPair(true);
  }, delay);
  logInfo({
    evento: "pairing.refresh.scheduled",
    emMs: delay,
    remainingTotalMs: remaining,
  });
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

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function cleanupCurrentSocket(reason?: string) {
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

function logConnectionUpdateFase(fase: string, extra?: any) {
  const verbose = /^(true)$/i.test(LOG_CONN_VERBOSE);
  const noisy = ["connecting", "syncing", "resuming", "qr"];
  if (!verbose && noisy.includes(fase)) return;
  const payload = { evento: "connection.update", fase, ...extra };
  if (logger) logger.info(payload);
  else pendingLogs.push({ level: "info", msg: payload });
}

type PendingLog = { level: "info" | "error"; msg: any };
const pendingLogs: PendingLog[] = [];
function logInfo(...args: any[]) {
  const msg = args.length === 1 ? args[0] : args;
  if (logger) logger.info(msg);
  else pendingLogs.push({ level: "info", msg });
}
function logError(...args: any[]) {
  const msg = args.length === 1 ? args[0] : args;
  if (logger) logger.error(msg);
  else pendingLogs.push({ level: "error", msg });
}
function flushPending() {
  if (!logger || !pendingLogs.length) return;
  for (const pl of pendingLogs) {
    pl.level === "error" ? logger.error(pl.msg) : logger.info(pl.msg);
  }
  pendingLogs.length = 0;
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

async function startBaileys() {
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
    logger.warn(
      { errPrimary },
      "Falha ao obter versao web; tentando versao Baileys recomendada"
    );
    try {
      const b = await fetchLatestBaileysVersion();
      version = b.version;
    } catch (errFallback) {
      logger.error(
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

  const isDirectJid = (jid?: string) => !!jid && /@s\.whatsapp\.net$/.test(jid);
  const isGroupJid = (jid?: string) => !!jid && /@g\.us$/.test(jid || "");
  const isBroadcastJid = (jid?: string) =>
    !!jid && /@broadcast$/.test(jid || "");
  const isNewsletterJid = (jid?: string) =>
    !!jid && /newsletter|channel/i.test(jid);
  const extractTextContent = (content: any): string | undefined => {
    if (!content) return undefined;
    if (typeof content.text === "string") return content.text;
    if (typeof content.conversation === "string") return content.conversation;
    if (content.extendedTextMessage?.text)
      return content.extendedTextMessage.text as string;
    return undefined;
  };
  function jidToNumber(jid: string | undefined) {
    if (!jid) return "desconhecido";
    return jid.split("@")[0].split(":")[0];
  }
  function sanitizeText(t?: string) {
    if (!t) return "";
    const oneLine = t.replace(/\s+/g, " ").trim();
    const MAX = 400;
    return oneLine.length > MAX ? oneLine.slice(0, MAX) + "…" : oneLine;
  }
  function logSimple(direction: "in" | "out", jid: string, text: string) {
    const numero = jidToNumber(jid);
    const clean = sanitizeText(text);
    const msg =
      direction === "out"
        ? `Mensagem enviada para ${numero}: ${clean}`
        : `Mensagem recebida de ${numero}: ${clean}`;
    if (MSG_LOG_ENABLED) logger?.info(msg);
  }

  const socketInstance = sock!;
  const originalSendMessage = socketInstance.sendMessage.bind(socketInstance);
  socketInstance.sendMessage = (async (
    jid: any,
    content: any,
    options?: any
  ): Promise<any> => {
    const txt = isDirectJid(jid) ? extractTextContent(content) : undefined;
    const result = await originalSendMessage(jid, content, options);
    if (txt && isDirectJid(jid)) {
      logSimple("out", jid, txt);
      if (result?.key?.id) {
        outboundMessages.set(result.key.id, {
          to: jid,
          text: txt,
          createdAt: Date.now(),
          status: 1,
        });
        trySendExternalStatus("Enviado", jid, result.key.id);
      }
      io.emit("message_out", {
        direction: "out",
        to: jid,
        text: txt,
        id: result?.key?.id,
        ts: Date.now(),
      });
    }
    return result;
  }) as any;

  if (sock) sock.ev.on("creds.update", saveCreds);
  if (!state.creds.registered && PAIR_PHONE) {
    waLogger.debug("Agendando auto pairing inicial (sessao nao registrada)");
    scheduleAutoPair(2000);
  }

  if (sock)
    sock.ev.process(async (events: Partial<BaileysEventMap>) => {
      if (events["connection.update"]) {
        const update: any = events["connection.update"];
        const { connection, lastDisconnect, qr } = update;
        connectionState = connection;
        io.emit("connection_state", { state: connectionState });
        if (connection && connection !== "open" && connection !== "close") {
          logConnectionUpdateFase(connection, { info: "Estado intermediario" });
        }
        if (qr) {
          logConnectionUpdateFase("qr", {
            ignorado: true,
            motivo: "fallback_desabilitado",
          });
        }
        if (connection === "open") {
          clearReconnectTimer();
          logConnectionUpdateFase("open", { mensagem: "Conexao estabelecida" });
          reconnectAttempts = 0;
          io.emit("ready", "Medicit conectado");
          const meJid =
            sock?.user?.id || sock?.authState.creds.me?.id || "desconhecido";
          let numero = meJid;
          if (numero !== "desconhecido") {
            numero = numero.split("@")[0].split(":")[0];
          }
          logger.info(`Sessao conectada com o numero ${numero}`);
          io.emit("message", "Sessao pronta.");
          autoPairAttempts = 0;
          if (
            sock &&
            !sock.authState.creds.registered &&
            PAIR_PHONE &&
            !lastPairing
          ) {
            scheduleAutoPair(1500);
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
          logConnectionUpdateFase("close", {
            codigo: friendly.codigo,
            chave: friendly.chave,
            titulo: friendly.titulo,
            sugestao: friendly.sugestao,
          });
          const pairingExpired = /QR refs attempts ended/i.test(rawMessage);
          if (pairingExpired) {
            logger.warn(
              "Pairing/QR expirado: gere novo codigo em /baileys/pair?phone=55DDDNUMERO"
            );
            io.emit("pairing_expired", {
              message: "Pairing/QR expirado. Gere novo codigo.",
            });
            lastPairingCodeAt = undefined;
            lastPairing = undefined;
            if (sock && !sock.authState.creds.registered) {
              setTimeout(() => {
                logInfo({
                  evento: "pairing.auto.regenerate",
                  motivo: "expired",
                });
                attemptAutoPair();
              }, 800);
            }
          }
          const critical =
            statusCode === DisconnectReason.badSession ||
            statusCode === DisconnectReason.forbidden ||
            statusCode === DisconnectReason.multideviceMismatch;
          if (!loggedOut && !critical) {
            reconnectAttempts++;
            const delay = calcDelay();
            const motivo = rawMessage || "desconhecido";
            logger.warn(
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
            reconnectTimer = setTimeout(() => startBaileys(), delay);
          } else {
            const wasRegistered = !!sock?.authState.creds.registered;
            logger.error(
              { wasRegistered, rawMessage, statusCode },
              "Sessao finalizada (logged out)"
            );
            const early = lastStartAt && Date.now() - lastStartAt < 7000;
            if (early) {
              lastPairingCodeAt = undefined;
              lastPairing = undefined;
              autoPairAttempts = 0;
              clearPairingRefreshTimer();
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
                  logger.error({ e }, "Falha ao remover pasta de sessao");
                }
                lastPairing = undefined;
                autoPairAttempts = 0;
                clearPairingRefreshTimer();
                if (early) await new Promise((r) => setTimeout(r, 1500));
                try {
                  await startBaileys();
                } catch (e2) {
                  logger.error({ e2 }, "Falha ao reiniciar apos limpeza");
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
            if (!msg?.message) continue;
            const jid = msg.key.remoteJid as string | undefined;
            if (!isDirectJid(jid)) continue;
            if (isGroupJid(jid) || isBroadcastJid(jid) || isNewsletterJid(jid))
              continue;
            const id = msg.key.id as string | undefined;
            if (alreadyLogged(id)) continue;
            const body =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              extractTextContent(msg.message) ||
              "";
            if (!body) continue;
            const direction = msg.key.fromMe ? "out" : "in";
            logSimple(direction, jid!, body);
            if (
              direction === "out" &&
              msg.key.id &&
              outboundMessages.has(msg.key.id)
            ) {
              const meta = outboundMessages.get(msg.key.id)!;
              if (!meta.status || meta.status < 2) {
                meta.status = 2;
                trySendExternalStatus("Recebido", jid!, msg.key.id);
              }
            }
            io.emit(direction === "in" ? "message_in" : "message_out", {
              direction,
              text: body,
              ts: msg.messageTimestamp,
              id,
              ...(direction === "in" ? { from: jid } : { to: jid }),
            });
            if (direction === "in" && id) {
              trySendExternalMessage(body, jid!, id);
            }
          }
        }
      }
      if (events["messages.update"]) {
        const updates = events["messages.update"] as any;
        for (const up of updates) {
          try {
            const id = up.key?.id;
            if (!id) continue;
            if (!up.key?.fromMe) continue;
            const st = up.update?.status;
            if (typeof st !== "number") continue;
            const meta = outboundMessages.get(id);
            if (!meta) continue;
            if (!meta.status || st > meta.status) {
              meta.status = st;
              let label: string | undefined;
              if (st === 1) label = "Enviado";
              else if (st === 2) label = "Recebido";
              else if (st === 3 || st === 4) label = "Visualizado";
              if (label) trySendExternalStatus(label, meta.to, id);
            }
          } catch {}
        }
      }
    });

  app.post("/baileys/send-text", async (req: Request, res: Response) => {
    try {
      const { number, message } = req.body as {
        number?: string;
        message?: string;
      };
      if (!number || !message)
        return res
          .status(400)
          .json({ ok: false, error: "number e message sao obrigatorios" });
      if (!sock)
        return res
          .status(500)
          .json({ ok: false, error: "Socket nao iniciado" });
      const jid = formatNumberToJid(number);
      await sock.sendMessage(jid, { text: message });
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/baileys/send-media", async (req: Request, res: Response) => {
    try {
      const { number, caption, file } = req.body as {
        number?: string;
        caption?: string;
        file?: string;
      };
      if (!number || !file)
        return res
          .status(400)
          .json({ ok: false, error: "number e file sao obrigatorios" });
      if (!sock)
        return res
          .status(500)
          .json({ ok: false, error: "Socket nao iniciado" });
      const resp = await axios.get(file, { responseType: "arraybuffer" });
      const mimeType =
        resp.headers["content-type"] || "application/octet-stream";
      const buffer = Buffer.from(resp.data);
      let content: any = {};
      if (/^image\//.test(mimeType)) content.image = buffer;
      else if (/^video\//.test(mimeType)) content.video = buffer;
      else content.document = buffer;
      if (caption) content.caption = caption;
      const jid = formatNumberToJid(number);
      const sent = await sock.sendMessage(jid, content);
      return res.json({ ok: true, id: sent?.key?.id });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
  starting = false;
}

app.get("/baileys/pair", async (req: Request, res: Response) => {
  try {
    if (!sock)
      return res
        .status(400)
        .json({ ok: false, error: "Socket ainda nao inicializado" });
    if (sock.authState.creds.registered)
      return res.status(400).json({
        ok: false,
        error:
          "Sessao ja registrada. Apague a pasta de sessao para novo pareamento.",
      });
    const force = /^(1|true|yes)$/i.test((req.query.force as string) || "");
    let phone = (req.query.phone as string) || PAIR_PHONE;
    if (!phone) {
      if (lastPairing && isPairingCodeValid(lastPairing)) {
        const remainingMs = lastPairing.expiresAt!.getTime() - Date.now();
        return res.json({
          ok: true,
          pairingCode: lastPairing.code,
          phone: lastPairing.phone,
          cached: true,
          remainingMs,
        });
      }
      return res.status(400).json({
        ok: false,
        error: "Informe phone=55DDDNUMERO ou defina PAIR_PHONE",
      });
    }
    phone = phone.replace(/\D/g, "");
    if (
      !force &&
      lastPairing &&
      lastPairing.phone === phone &&
      isPairingCodeValid(lastPairing) &&
      lastPairing.expiresAt!.getTime() - Date.now() >
        PAIRING_MIN_REUSE_REMAINING_MS
    ) {
      const remainingMs = lastPairing.expiresAt!.getTime() - Date.now();
      return res.json({
        ok: true,
        pairingCode: lastPairing.code,
        phone: lastPairing.phone,
        cached: true,
        remainingMs,
      });
    }
    const code = await sock.requestPairingCode(phone);
    const nowTs = Date.now();
    lastPairing = {
      phone,
      code,
      at: new Date(nowTs),
      expiresAt: new Date(nowTs + PAIRING_CODE_TTL_MS),
    };
    clearPairingRefreshTimer();
    schedulePairingRefresh();
    io.emit("pairing_code", code);
    logInfo(`Pairing code gerado para ${phone}: ${code}`);
    return res.json({
      ok: true,
      pairingCode: code,
      phone,
      expiresAt: lastPairing.expiresAt,
      ttlMs: PAIRING_CODE_TTL_MS,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/baileys/reset", async (_req: Request, res: Response) => {
  try {
    cleanupCurrentSocket("manual_reset");
    await fs.rm(path.resolve(SESSION_FOLDER), { recursive: true, force: true });
    lastPairing = undefined;
    clearPairingRefreshTimer();
    autoPairAttempts = 0;
    clearPairingRefreshTimer();
    restartScheduled = true;
    setTimeout(async () => {
      try {
        await startBaileys();
        restartScheduled = false;
        if (sock && !sock.authState.creds.registered && PAIR_PHONE)
          scheduleAutoPair(1200);
      } catch (e) {
        restartScheduled = false;
        logger.error({ e }, "Falha ao reiniciar depois de reset manual");
      }
    }, 400);
    res.json({ ok: true, message: "Sessao resetada; reiniciando." });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/baileys/status", (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    connection: connectionState,
    registered: !!sock?.authState.creds.registered,
    reconnectAttempts,
    autoPairAttempts,
    lastPairing: lastPairing
      ? {
          phone: lastPairing.phone,
          at: lastPairing.at,
          code: !!lastPairing.code,
          expiresAt: lastPairing.expiresAt,
          remainingMs: lastPairing.expiresAt
            ? Math.max(0, lastPairing.expiresAt.getTime() - Date.now())
            : null,
          valid: isPairingCodeValid(lastPairing),
        }
      : null,
    restartScheduled,
  });
});

function formatNumberToJid(raw: string) {
  let number = raw.replace(/\D/g, "");
  if (!number.endsWith("@s.whatsapp.net")) number = number + "@s.whatsapp.net";
  return jidNormalizedUser(number);
}

// --- Integração externa  ---
async function postExternal(payload: any) {
  try {
    await axios.post(EXTERNAL_ENDPOINT, payload, {
      headers: { "Content-Type": "application/vnd.api+json" },
      timeout: 8000,
    });
  } catch (e: any) {
    logger?.warn(
      { e: e.message, payload },
      "Falha ao enviar para endpoint externo"
    );
  }
}

function trySendExternalMessage(
  resposta: string,
  numeroJid: string,
  idMsg: string
) {
  const numero = numeroJid.split("@")[0];
  const body = {
    resposta,
    nrCelular: numero,
    tipo: "mensagem",
    idlog: idMsg,
    referencia_status: "Enviado",
    nrPorta: PORT,
    idDominio: 0,
  };
  postExternal(body);
}

function trySendExternalStatus(
  status: string,
  numeroJid: string,
  idMsg: string
) {
  const numero = numeroJid.split("@")[0];
  const body = {
    resposta: status,
    nrCelular: numero,
    tipo: "status",
    idlog: idMsg,
    referencia_status: status,
    nrPorta: PORT,
    idDominio: 0,
  };
  postExternal(body);
}

(async () => {
  try {
    logger = await createLogger(LOG_LEVEL as any);
    server.listen(PORT, () => {
      logInfo(`Servidor Medicit iniciado na porta ${PORT}`);
    });
    if (!started) {
      await startBaileys();
      started = true;
    }
    flushPending();
  } catch (err) {
    logError("Falha ao iniciar logger/baileys", err);
  }
})();

function scheduleAutoPair(initialDelay = 1200) {
  if (!PAIR_PHONE) return;
  if (autoPairAttempts > 0 && lastPairing) return;
  setTimeout(() => {
    attemptAutoPair();
  }, initialDelay);
}

async function attemptAutoPair(force = false) {
  if (!sock) return;
  if (sock.authState.creds.registered) return;
  if (!PAIR_PHONE) return;
  const phone = PAIR_PHONE.replace(/\D/g, "");
  try {
    const nowTs = Date.now();
    if (!force) {
      if (
        lastPairing &&
        lastPairing.phone === phone &&
        isPairingCodeValid(lastPairing) &&
        lastPairing.expiresAt!.getTime() - Date.now() >
          PAIRING_MIN_REUSE_REMAINING_MS
      ) {
        logInfo({ evento: "pairing.auto.skip.valid_existing" });
        return;
      }
      if (
        lastPairingCodeAt &&
        nowTs - lastPairingCodeAt < AUTO_PAIR_COOLDOWN_MS
      ) {
        logInfo({
          evento: "pairing.skip.cooldown",
          restanteMs: AUTO_PAIR_COOLDOWN_MS - (nowTs - lastPairingCodeAt),
        });
        return;
      }
    }
    autoPairAttempts++;
    const code = await sock.requestPairingCode(phone);
    lastPairing = {
      phone,
      code,
      at: new Date(nowTs),
      expiresAt: new Date(nowTs + PAIRING_CODE_TTL_MS),
    };
    lastPairingCodeAt = nowTs;
    io.emit("pairing_code", code);
    clearPairingRefreshTimer();
    schedulePairingRefresh();
    logInfo(
      `${
        force ? "(AutoForce)" : "(Auto)"
      } Pairing code gerado (tentativa ${autoPairAttempts}) para ${phone}: ${code}`
    );
  } catch (err: any) {
    if (autoPairAttempts < MAX_AUTO_PAIR_ATTEMPTS) {
      const backoff = 1000 * Math.pow(2, autoPairAttempts - 1);
      logInfo(
        `Falha auto pairing tentativa ${autoPairAttempts}: ${
          err?.message || "erro"
        }. Retry em ${backoff}ms`
      );
      setTimeout(() => attemptAutoPair(false), backoff);
    } else {
      logError(
        `Falha ao gerar pairing code automatico apos ${autoPairAttempts} tentativas`,
        err
      );
    }
  }
}

let shuttingDown = false;
async function gracefulShutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    logInfo({ evento: "shutdown.start", reason });
    clearReconnectTimer();
    const connected =
      connectionState === "open" && !!sock?.authState.creds.registered;
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

function bindProcessSignals() {
  const signals: NodeJS.Signals[] = [
    "SIGINT",
    "SIGTERM",
    "SIGUSR2",
    "SIGBREAK",
  ];
  for (const sig of signals) {
    try {
      process.on(sig, () => gracefulShutdown(sig, 0));
    } catch {}
  }
  try {
    process.on("message", (msg: any) => {
      if (msg === "SIGINT" || msg === "shutdown")
        gracefulShutdown("message:" + msg, 0);
    });
  } catch {}
  process.on("uncaughtException", (err) => {
    logError({ err }, "uncaughtException");
    gracefulShutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason: any) => {
    logError({ reason }, "unhandledRejection");
    gracefulShutdown("unhandledRejection", 1);
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

bindProcessSignals();
