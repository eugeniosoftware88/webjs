import axios from "axios";
import { EXTERNAL_ENDPOINT, PORT } from "./config";
import { dynamicConfig } from "./dynamicConfig";
import { getLogger } from "./logger";

// --- Integracao externa  ---
async function postExternal(payload: any) {
  try {
    const endpoint = dynamicConfig.getExternalEndpoint() || EXTERNAL_ENDPOINT;
    await axios.post(endpoint, payload, {
      headers: { "Content-Type": "application/vnd.api+json" },
      timeout: 8000,
    });
  } catch (e: any) {
    const logger = getLogger();
    logger?.warn(
      { e: e.message, payload },
      "Falha ao enviar para endpoint externo"
    );
  }
}

export function trySendExternalMessage(
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
    referencia_status: "Recebido",
    nrPorta: PORT,
    idDominio: 0,
  };
  postExternal(body);
}

export function trySendExternalStatus(
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
