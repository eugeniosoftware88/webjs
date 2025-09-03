import "dotenv/config";
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import createLogger, { logInfo, logError, flushPending } from "./logger";
import { PORT, LOG_LEVEL, ADMIN_TOKEN, APP_URL } from "./config";
import { startBaileys, isStarted, setStarted } from "./initWa";
import { setupRoutes } from "./routes";
import { setupAdminRoutes } from "./adminRoutes";
import { bindProcessSignals } from "./shutdown";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/favicon.ico", (req, res) => {
  res.set({
    "Cache-Control": "public, max-age=86400",
    "Content-Type": "image/x-icon",
  });
  res.sendFile("favicon.ico", { root: process.cwd() + "/public" });
});

if (ADMIN_TOKEN) {
  app.use("/", express.static(process.cwd() + "/public"));
}

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  socket.on("force_logout", async () => {
    logInfo("Recebido comando de force_logout do cliente");

    try {
      const { getSocket } = require("./initWa");
      const sock = getSocket();

      if (sock && sock.user) {
        logInfo("Enviando comando de logout para o WhatsApp");
        try {
          await sock.logout();
          logInfo("Comando de logout enviado com sucesso");
        } catch (logoutError) {
          logError("Erro especifico no logout:", logoutError);
          try {
            await sock.end();
            logInfo("Socket encerrado como alternativa ao logout");
          } catch (endError) {
            logError("Erro ao encerrar socket:", endError);
          }
        }
      } else {
        logInfo(
          "Socket do WhatsApp nao encontrado ou nao autenticado para logout"
        );
      }
    } catch (error) {
      logError("Erro ao processar logout:", error);
    }
  });
  if (ADMIN_TOKEN) {
    setTimeout(() => {
      const { getSocket, getConnectionStatus } = require("./initWa");
      const sock = getSocket();
      const connectionStatus = getConnectionStatus();

      if (sock && connectionStatus.connection === "open") {
        const meJid = sock.user?.id || sock.authState.creds.me?.id;
        let numero = undefined;
        if (meJid) {
          numero = meJid.split("@")[0].split(":")[0];
        }

        const statusToSend = {
          connected: true,
          connecting: false,
          user: numero,
          registered: connectionStatus.registered,
        };

        socket.emit("connection_update", statusToSend);
      } else if (connectionStatus.connection === "connecting") {
        const statusToSend = {
          connected: false,
          connecting: true,
          user: undefined,
          registered: connectionStatus.registered,
        };

        socket.emit("connection_update", statusToSend);
      } else {
        const statusToSend = {
          connected: false,
          connecting: false,
          user: undefined,
          registered: connectionStatus.registered,
        };

        socket.emit("connection_update", statusToSend);
      }
    }, 500);
  }
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

setupRoutes(app, io);

if (ADMIN_TOKEN) {
  setupAdminRoutes(app, io);
  logInfo(`Modo ADMIN - Interface web disponivel em ${APP_URL}/admin`);
}

(async () => {
  try {
    await createLogger(LOG_LEVEL as any);
    server.listen(PORT, () => {
      logInfo(`Servidor Medicit iniciado na porta ${PORT}`);
    });

    if (!isStarted()) {
      await startBaileys(io, false);
      setStarted(true);
    }

    flushPending();
  } catch (err) {
    logError("Falha ao iniciar logger/baileys", err);
  }
})();

bindProcessSignals(server);
