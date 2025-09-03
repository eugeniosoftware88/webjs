export const APP_CONFIG = {
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
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || undefined,
  APP_URL:
    process.env.APP_URL || `http://localhost:${process.env.PORT || "8000"}`,
} as const;

export const {
  PORT,
  LOG_LEVEL,
  WA_LOG_LEVEL,
  SESSION_FOLDER,
  PAIR_PHONE,
  LOG_WA_MESSAGES,
  LOG_CONN_VERBOSE,
  EXTERNAL_ENDPOINT,
  ADMIN_TOKEN,
  APP_URL,
} = APP_CONFIG;

export const MSG_LOG_ENABLED = (() => {
  if (LOG_WA_MESSAGES == null) return true;
  if (/^(true)$/i.test(LOG_WA_MESSAGES)) return true;
  if (/^(false)$/i.test(LOG_WA_MESSAGES)) return false;
  return false;
})();

// pareamento
export const PAIRING_CODE_TTL_MS = 180_000;
export const PAIRING_REFRESH_LEEWAY_MS = 10_000;
export const PAIRING_MIN_REUSE_REMAINING_MS = 12_000;
export const MAX_AUTO_PAIR_ATTEMPTS = 6;
export const AUTO_PAIR_COOLDOWN_MS = 12_000;

// reconexao
export const MAX_RECONNECT_DELAY = 60000;
