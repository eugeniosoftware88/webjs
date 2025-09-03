import express, { Request, Response } from "express";
import path from "path";
import { ADMIN_TOKEN, PAIR_PHONE, EXTERNAL_ENDPOINT } from "./config";
import { dynamicConfig } from "./dynamicConfig";
import {
  getSocket,
  resetSession,
  getConnectionStatus,
  forceImmediateQR,
} from "./initWa";
import { generatePairingCodeAdmin, getPairingInfo } from "./pairing";
import { logInfo, logError } from "./logger";
import { Server as SocketIOServer } from "socket.io";

interface AuthRequest extends Request {
  isAdmin?: boolean;
}

function requireAdminAuth(
  req: AuthRequest,
  res: Response,
  next: express.NextFunction
) {
  if (!ADMIN_TOKEN) {
    return res
      .status(503)
      .json({ ok: false, error: "Modo administrativo nao configurado" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ ok: false, error: "Token de autorizacao necessario" });
  }

  const token = authHeader.substring(7);
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: "Token invalido" });
  }

  req.isAdmin = true;
  next();
}

export function setupAdminRoutes(app: express.Application, io: SocketIOServer) {
  if (ADMIN_TOKEN) {
    app.get("/admin", (req: Request, res: Response) => {
      res.sendFile(path.join(process.cwd(), "public", "admin.html"));
    });

    app.get("/", (req: Request, res: Response) => {
      res.redirect("/admin");
    });
  }

  app.post("/admin/auth", (req: Request, res: Response) => {
    if (!ADMIN_TOKEN) {
      return res
        .status(503)
        .json({ ok: false, error: "Modo administrativo nao configurado" });
    }

    const { token } = req.body;
    if (token === ADMIN_TOKEN) {
      return res.json({ ok: true });
    } else {
      logInfo("Tentativa de acesso administrativo com token invalido");
      return res.status(403).json({ ok: false, error: "Token invalido" });
    }
  });

  app.get(
    "/admin/config",
    requireAdminAuth,
    (req: AuthRequest, res: Response) => {
      const dynamicConf = dynamicConfig.getConfig();

      const config = {
        PAIR_PHONE: dynamicConf.PAIR_PHONE || PAIR_PHONE || "",
        EXTERNAL_ENDPOINT:
          dynamicConf.EXTERNAL_ENDPOINT || EXTERNAL_ENDPOINT || "",
      };

      res.json({ ok: true, config });
    }
  );

  app.post(
    "/admin/config",
    requireAdminAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const { PAIR_PHONE, EXTERNAL_ENDPOINT } = req.body;

        const updateData: any = {};

        if (PAIR_PHONE !== undefined) {
          if (PAIR_PHONE && !/^\d+$/.test(PAIR_PHONE)) {
            return res.status(400).json({
              ok: false,
              error: "Telefone deve conter apenas numeros",
            });
          }
          updateData.PAIR_PHONE = PAIR_PHONE;
        }

        if (EXTERNAL_ENDPOINT !== undefined) {
          if (EXTERNAL_ENDPOINT && !isValidUrl(EXTERNAL_ENDPOINT)) {
            return res
              .status(400)
              .json({ ok: false, error: "Endpoint deve ser uma URL valida" });
          }
          updateData.EXTERNAL_ENDPOINT = EXTERNAL_ENDPOINT;
        }

        await dynamicConfig.updateConfig(updateData);
        logInfo("Configuracoes administrativas atualizadas", updateData);

        res.json({ ok: true, config: dynamicConfig.getConfig() });
      } catch (error) {
        logError("Erro ao atualizar configuracoes", error);
        res.status(500).json({ ok: false, error: "Erro interno do servidor" });
      }
    }
  );

  app.post(
    "/admin/pairing-code",
    requireAdminAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const { phone } = req.body;
        const sock = getSocket();

        if (!sock) {
          return res
            .status(500)
            .json({ ok: false, error: "Socket nao inicializado" });
        }

        if (sock.authState.creds.registered) {
          const connectionStatus = getConnectionStatus();
          if (connectionStatus.connection === "open") {
            return res.status(400).json({
              ok: false,
              error:
                "Sessao ja esta conectada. Use 'Reset Sessao' para gerar novo codigo.",
            });
          }
        }

        const configuredPhone = phone || dynamicConfig.getPairPhone();
        if (!configuredPhone) {
          return res
            .status(400)
            .json({ ok: false, error: "Telefone nao configurado" });
        }

        const result = await generatePairingCodeAdmin(
          sock,
          configuredPhone,
          io
        );
        res.json(result);
      } catch (error) {
        logError("Erro ao gerar codigo de pareamento administrativo", error);
        res.status(500).json({ ok: false, error: "Erro interno do servidor" });
      }
    }
  );

  app.post(
    "/admin/qr-code",
    requireAdminAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const sock = getSocket();

        if (!sock) {
          return res
            .status(500)
            .json({ ok: false, error: "Socket nao inicializado" });
        }

        if (sock.authState.creds.registered) {
          const connectionStatus = getConnectionStatus();
          if (connectionStatus.connection === "open") {
            return res.status(400).json({
              ok: false,
              error:
                "Sessao ja esta conectada e registrada. Use 'Reset Sessao' para gerar novo QR.",
            });
          } else {
            return res.status(400).json({
              ok: false,
              error:
                "Sessao ja registrada. Use 'Reset Sessao' para gerar novo QR.",
            });
          }
        }

        const success = await forceImmediateQR(io);

        if (!success) {
          return res.status(400).json({
            ok: false,
            error: "Nao e possivel gerar QR Code no momento",
          });
        }

        logInfo("QR Code solicitado via painel administrativo");
        res.json({
          ok: true,
          message: "QR Code sendo gerado. Aguarde alguns segundos...",
        });
      } catch (error) {
        logError("Erro ao gerar QR Code administrativo", error);
        res.status(500).json({ ok: false, error: "Erro interno do servidor" });
      }
    }
  );

  app.post(
    "/admin/reset",
    requireAdminAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const result = await resetSession(io);
        logInfo("Reset de sessao solicitado pelo painel administrativo");
        res.json(result);
      } catch (error) {
        logError("Erro ao resetar sessao via admin", error);
        res.status(500).json({ ok: false, error: "Erro interno do servidor" });
      }
    }
  );

  app.get(
    "/admin/status",
    requireAdminAuth,
    (req: AuthRequest, res: Response) => {
      const connectionStatus = getConnectionStatus();

      let user = undefined;
      let connected = false;
      let connecting = false;

      if (
        connectionStatus.socketActive &&
        connectionStatus.connection === "open"
      ) {
        connected = true;
        if (connectionStatus.userId) {
          const numero = connectionStatus.userId.split("@")[0].split(":")[0];
          user = numero;
        }
      } else if (connectionStatus.connection === "connecting") {
        connecting = true;
      }

      const status = {
        connected,
        connecting,
        user,
        registered: connectionStatus.registered,
        hasCredentials: connectionStatus.hasCredentials,
        connection: connectionStatus.connection,
        reconnectAttempts: connectionStatus.reconnectAttempts,
        restartScheduled: connectionStatus.restartScheduled,
        socketActive: connectionStatus.socketActive,
      };

      res.json({ ok: true, status });
    }
  );

  app.get(
    "/admin/pairing-info",
    requireAdminAuth,
    (req: AuthRequest, res: Response) => {
      const info = getPairingInfo();
      res.json({ ok: true, info });
    }
  );
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
