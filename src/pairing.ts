import { WASocket } from "baileys";
import {
  PAIR_PHONE,
  PAIRING_CODE_TTL_MS,
  PAIRING_REFRESH_LEEWAY_MS,
  PAIRING_MIN_REUSE_REMAINING_MS,
  MAX_AUTO_PAIR_ATTEMPTS,
  AUTO_PAIR_COOLDOWN_MS,
  ADMIN_TOKEN,
} from "./config";
import { dynamicConfig } from "./dynamicConfig";
import { logInfo, logError } from "./logger";
import { Server as SocketIOServer } from "socket.io";
import { resumeReconnections, startBaileys } from "./initWa";

let lastPairing:
  | { phone: string; code: string; at: Date; expiresAt?: Date }
  | undefined;
let pairingRefreshTimer: NodeJS.Timeout | undefined;
let autoPairAttempts = 0;
let lastPairingCodeAt: number | undefined;

export function clearPairingRefreshTimer() {
  if (pairingRefreshTimer) {
    clearTimeout(pairingRefreshTimer);
    pairingRefreshTimer = undefined;
  }
}

export function isPairingCodeValid(p: typeof lastPairing | undefined) {
  if (!p) return false;
  if (!p.expiresAt) return false;
  return Date.now() < p.expiresAt.getTime();
}

export function schedulePairingRefresh(sock: WASocket | undefined) {
  if (!lastPairing || !lastPairing.expiresAt) return;
  if (sock?.authState.creds.registered) return;
  clearPairingRefreshTimer();
  const remaining = lastPairing.expiresAt.getTime() - Date.now();
  if (remaining <= 0) {
    logInfo({ evento: "pairing.refresh.immediate", motivo: "expired" });
    attemptAutoPair(sock, true);
    return;
  }
  const delay = Math.max(200, remaining - PAIRING_REFRESH_LEEWAY_MS);
  pairingRefreshTimer = setTimeout(() => {
    logInfo({ evento: "pairing.refresh.trigger", remainingBefore: remaining });
    attemptAutoPair(sock, true);
  }, delay);
  logInfo({
    evento: "pairing.refresh.scheduled",
    emMs: delay,
    remainingTotalMs: remaining,
  });
}

export function scheduleAutoPair(
  sock: WASocket | undefined,
  initialDelay = 1200
) {
  if (ADMIN_TOKEN) {
    return;
  }

  const currentPairPhone = dynamicConfig.getPairPhone() || PAIR_PHONE;
  if (!currentPairPhone) return;
  if (autoPairAttempts > 0 && lastPairing) return;
  setTimeout(() => {
    attemptAutoPair(sock);
  }, initialDelay);
}

export async function attemptAutoPair(
  sock: WASocket | undefined,
  force = false,
  io?: SocketIOServer
) {
  if (!sock) return;
  if (sock.authState.creds.registered) return;

  if (ADMIN_TOKEN && !force) {
    logInfo("Auto-pair bloqueado: modo admin ativo");
    return;
  }

  const currentPairPhone = dynamicConfig.getPairPhone() || PAIR_PHONE;
  if (!currentPairPhone) return;

  const phone = currentPairPhone.replace(/\D/g, "");
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
    if (io) {
      io.emit("pairing_code", code);
    }
    clearPairingRefreshTimer();
    schedulePairingRefresh(sock);
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
      setTimeout(() => attemptAutoPair(sock, false, io), backoff);
    } else {
      logError(
        `Falha ao gerar pairing code automatico apos ${autoPairAttempts} tentativas`,
        err
      );
    }
  }
}

export async function generatePairingCode(
  sock: WASocket,
  phone: string,
  force: boolean = false,
  io?: SocketIOServer
): Promise<{
  ok: boolean;
  pairingCode?: string;
  phone?: string;
  cached?: boolean;
  remainingMs?: number;
  expiresAt?: Date;
  ttlMs?: number;
  error?: string;
}> {
  try {
    if (!sock) {
      return { ok: false, error: "Socket ainda nao inicializado" };
    }
    if (sock.authState.creds.registered) {
      return {
        ok: false,
        error:
          "Sessao ja registrada. Apague a pasta de sessao para novo pareamento.",
      };
    }

    if (!phone) {
      if (lastPairing && isPairingCodeValid(lastPairing)) {
        const remainingMs = lastPairing.expiresAt!.getTime() - Date.now();
        return {
          ok: true,
          pairingCode: lastPairing.code,
          phone: lastPairing.phone,
          cached: true,
          remainingMs,
        };
      }
      return {
        ok: false,
        error: "Informe phone=55DDDNUMERO ou defina PAIR_PHONE",
      };
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
      return {
        ok: true,
        pairingCode: lastPairing.code,
        phone: lastPairing.phone,
        cached: true,
        remainingMs,
      };
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
    schedulePairingRefresh(sock);
    if (io) {
      io.emit("pairing_code", code);
    }
    logInfo(`Pairing code gerado para ${phone}: ${code}`);
    return {
      ok: true,
      pairingCode: code,
      phone,
      expiresAt: lastPairing.expiresAt,
      ttlMs: PAIRING_CODE_TTL_MS,
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export function getPairingStatus() {
  return lastPairing
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
    : null;
}

export function resetPairingState() {
  lastPairing = undefined;
  clearPairingRefreshTimer();
  autoPairAttempts = 0;
  lastPairingCodeAt = undefined;
}

export function getAutoPairAttempts() {
  return autoPairAttempts;
}

export function resetAutoPairAttempts() {
  autoPairAttempts = 0;
}

export async function generatePairingCodeAdmin(
  sock: WASocket,
  phone: string,
  io?: SocketIOServer
): Promise<{
  ok: boolean;
  pairingCode?: string;
  phone?: string;
  expiresAt?: Date;
  error?: string;
}> {
  try {
    resumeReconnections();

    if (!sock) {
      logInfo("Socket não disponível para pareamento, reiniciando conexão...");
      if (io) {
        await startBaileys(io, true);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return {
        ok: false,
        error:
          "Socket sendo reinicializado. Tente novamente em alguns segundos.",
      };
    }

    if (sock.authState.creds.registered) {
      return {
        ok: false,
        error: "Sessao ja registrada. Reset a sessao para novo pareamento.",
      };
    }

    if (!dynamicConfig.canRequestPairingCode()) {
      const remaining = dynamicConfig.getRemainingPairingAttempts();
      const timeUntilReset = dynamicConfig.getTimeUntilPairingReset();
      return {
        ok: false,
        error: `Limite de tentativas atingido. Aguarde ${Math.ceil(
          timeUntilReset / (1000 * 60)
        )} minutos ou use QR Code.`,
      };
    }

    const cleanPhone = phone.replace(/\D/g, "");
    const code = await sock.requestPairingCode(cleanPhone);

    const nowTs = Date.now();
    lastPairing = {
      phone: cleanPhone,
      code,
      at: new Date(nowTs),
      expiresAt: new Date(nowTs + PAIRING_CODE_TTL_MS),
    };

    lastPairingCodeAt = nowTs;
    dynamicConfig.addPairingAttempt();

    clearPairingRefreshTimer();
    schedulePairingRefresh(sock);

    try {
      const { resumeReconnections } = await import("./initWa.js");
      resumeReconnections();
    } catch (err) {
      logError("Erro ao retomar reconexoes", err);
    }

    if (io) {
      io.emit("pairing_code", code);
    }

    logInfo(`Pairing code gerado para ${cleanPhone}: ${code}`);

    return {
      ok: true,
      pairingCode: code,
      phone: cleanPhone,
      expiresAt: lastPairing.expiresAt,
    };
  } catch (e: any) {
    logError("Erro ao gerar codigo de pareamento administrativo", e);
    return { ok: false, error: e.message };
  }
}

export function getPairingInfo() {
  return {
    attempts: dynamicConfig.getPairingAttemptsCount(),
    remainingAttempts: dynamicConfig.getRemainingPairingAttempts(),
    timeUntilReset: dynamicConfig.getTimeUntilPairingReset(),
    canRequestCode: dynamicConfig.canRequestPairingCode(),
  };
}
