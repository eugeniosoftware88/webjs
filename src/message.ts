import { WASocket } from "baileys";
import { MSG_LOG_ENABLED } from "./config";
import { getLogger } from "./logger";
import { trySendExternalStatus } from "./external";
import { Server as SocketIOServer } from "socket.io";

interface OutboundMsgMeta {
  to: string;
  text?: string;
  createdAt: number;
  status?: number;
}

export const outboundMessages = new Map<string, OutboundMsgMeta>();
export const loggedMsgIds = new Set<string>();

export function alreadyLogged(id?: string) {
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

export const isDirectJid = (jid?: string) =>
  !!jid && /@s\.whatsapp\.net$/.test(jid);
export const isGroupJid = (jid?: string) => !!jid && /@g\.us$/.test(jid || "");
export const isBroadcastJid = (jid?: string) =>
  !!jid && /@broadcast$/.test(jid || "");
export const isNewsletterJid = (jid?: string) =>
  !!jid && /newsletter|channel/i.test(jid);

export const extractTextContent = (content: any): string | undefined => {
  if (!content) return undefined;
  if (typeof content.text === "string") return content.text;
  if (typeof content.conversation === "string") return content.conversation;
  if (content.extendedTextMessage?.text)
    return content.extendedTextMessage.text as string;
  return undefined;
};

export function jidToNumber(jid: string | undefined) {
  if (!jid) return "desconhecido";
  return jid.split("@")[0].split(":")[0];
}

export function sanitizeText(t?: string) {
  if (!t) return "";
  const oneLine = t.replace(/\s+/g, " ").trim();
  const MAX = 400;
  return oneLine.length > MAX ? oneLine.slice(0, MAX) + "…" : oneLine;
}

export function logSimple(direction: "in" | "out", jid: string, text: string) {
  const numero = jidToNumber(jid);
  const clean = sanitizeText(text);
  const msg =
    direction === "out"
      ? `Mensagem enviada para ${numero}: ${clean}`
      : `Mensagem recebida de ${numero}: ${clean}`;
  if (MSG_LOG_ENABLED) {
    const logger = getLogger();
    logger?.info(msg);
  }
}

export function formatNumberToJid(raw: string, jidNormalizedUser?: any) {
  let number = raw.replace(/\D/g, "");
  if (!number.endsWith("@s.whatsapp.net")) number = number + "@s.whatsapp.net";
  return jidNormalizedUser ? jidNormalizedUser(number) : number;
}

export function enhanceSocketWithMessageLogging(
  sock: WASocket,
  io: SocketIOServer,
  jidNormalizedUser: any
) {
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = (async (
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

  return sock;
}
