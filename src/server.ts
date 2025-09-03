import "dotenv/config";
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import createLogger, { logInfo, logError, flushPending } from "./logger";
import { PORT, LOG_LEVEL } from "./config";
import { startBaileys, isStarted, setStarted } from "./initWa";
import { setupRoutes } from "./routes";
import { bindProcessSignals } from "./shutdown";

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

// rotas
setupRoutes(app, io);

// Inicialização principal
(async () => {
  try {
    const logger = await createLogger(LOG_LEVEL as any);
    server.listen(PORT, () => {
      logInfo(`Servidor Medicit iniciado na porta ${PORT}`);
    });

    if (!isStarted()) {
      await startBaileys(io);
      setStarted(true);
    }

    flushPending();
  } catch (err) {
    logError("Falha ao iniciar logger/baileys", err);
  }
})();

bindProcessSignals(server);
