import express, { Request, Response } from "express";
import axios from "axios";
import {
  getSocket,
  resetSession,
  getConnectionStatus,
  getJidNormalizedUser,
} from "./initWa";
import { generatePairingCode, getPairingStatus } from "./pairing";
import { formatNumberToJid } from "./message";
import { PAIR_PHONE } from "./config";
import { Server as SocketIOServer } from "socket.io";

export function setupRoutes(app: express.Application, io: SocketIOServer) {
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

      const sock = getSocket();
      if (!sock)
        return res
          .status(500)
          .json({ ok: false, error: "Socket nao iniciado" });

      const jid = formatNumberToJid(number, getJidNormalizedUser());
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

      const sock = getSocket();
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
      const jid = formatNumberToJid(number, getJidNormalizedUser());
      const sent = await sock.sendMessage(jid, content);
      return res.json({ ok: true, id: sent?.key?.id });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/baileys/pair", async (req: Request, res: Response) => {
    const force = /^(1|true|yes)$/i.test((req.query.force as string) || "");
    let phone = (req.query.phone as string) || PAIR_PHONE;

    const sock = getSocket();
    const result = await generatePairingCode(sock!, phone, force, io);

    if (result.ok) {
      return res.json(result);
    } else {
      return res
        .status(result.error?.includes("ja registrada") ? 400 : 500)
        .json(result);
    }
  });

  app.post("/baileys/reset", async (_req: Request, res: Response) => {
    const result = await resetSession(io);
    if (result.ok) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  });

  app.get("/baileys/status", (_req: Request, res: Response) => {
    const status = getConnectionStatus();
    const pairingStatus = getPairingStatus();

    return res.json({
      ...status,
      lastPairing: pairingStatus,
    });
  });
}
