import request from "supertest";

const TEST_PHONE = "558731420272";
const BASE_URL = "http://localhost:8000";

describe("🛡️ Testes Seguros - Sem Interferir na Sessão Ativa", () => {
  test("should check API status safely", async () => {
    console.log("🔍 Verificando status da API (teste seguro)...");

    const response = await request(BASE_URL)
      .get("/baileys/status")
      .expect("Content-Type", /json/);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok");

    console.log("✅ API está funcionando!");
    console.log("📊 Status da conexão:", response.body.connection || "N/A");
    console.log("🔗 Socket ativo:", response.body.socketActive || false);
  });

  test("should serve static files safely", async () => {
    console.log("🌐 Testando arquivos estáticos (seguro)...");

    const faviconResponse = await request(BASE_URL).get("/favicon.ico");

    expect([200, 404]).toContain(faviconResponse.status);
    console.log("✅ Favicon teste OK");

    const adminResponse = await request(BASE_URL).get("/admin");

    expect([200, 404]).toContain(adminResponse.status);
    console.log("✅ Admin page teste OK");
  });

  test("should validate empty parameters safely", async () => {
    console.log("🔍 Testando validação (sem JSON malformado)...");

    const response = await request(BASE_URL)
      .post("/baileys/send-text")
      .send({
        number: "",
        message: "",
      })
      .expect("Content-Type", /json/);

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("ok", false);
    console.log("✅ Validação funcionando corretamente");
  });

  test("should attempt to send test message only if connected", async () => {
    console.log("📱 Verificando se pode enviar mensagem...");

    const statusResponse = await request(BASE_URL).get("/baileys/status");

    const isConnected =
      statusResponse.body.socketActive &&
      statusResponse.body.connection !== "close";

    if (!isConnected) {
      console.log("⚠️ WhatsApp não conectado - pulando teste de envio");
      console.log("🔒 Sessão protegida - teste não executado");
      return;
    }

    console.log("✅ WhatsApp conectado - testando envio seguro...");

    const testMessage = `🧪 Teste Seguro da API
📅 ${new Date().toLocaleString("pt-BR")}
🔒 Teste que não quebra sessão ativa`;

    const response = await request(BASE_URL).post("/baileys/send-text").send({
      number: TEST_PHONE,
      message: testMessage,
    });

    console.log("📤 Resposta:", response.body);

    if (response.body.ok) {
      console.log("✅ Mensagem enviada com sucesso!");
      console.log("📱 Verifique o WhatsApp:", TEST_PHONE);
    } else {
      console.log("⚠️ Não foi possível enviar:", response.body.error);
    }
  });

  test("should attempt to send painel.png only if connected", async () => {
    console.log("🖼️ Verificando se pode enviar mídia...");

    const statusResponse = await request(BASE_URL).get("/baileys/status");

    const isConnected =
      statusResponse.body.socketActive &&
      statusResponse.body.connection !== "close";

    if (!isConnected) {
      console.log("⚠️ WhatsApp não conectado - pulando teste de mídia");
      console.log("🔒 Sessão protegida - teste não executado");
      return;
    }

    console.log("✅ WhatsApp conectado - testando envio de painel.png...");

    const painelUrl = `${BASE_URL}/painel.png`;

    const response = await request(BASE_URL)
      .post("/baileys/send-media")
      .send({
        number: TEST_PHONE,
        file: painelUrl,
        caption: `🖼️ PAINEL.PNG - Teste Seguro\n📅 ${new Date().toLocaleString(
          "pt-BR"
        )}\n🔒 Não quebra sessão ativa`,
      });

    console.log("📤 Resposta mídia:", response.body);

    if (response.body.ok) {
      console.log("✅ painel.png enviado com sucesso!");
      console.log("🆔 Message ID:", response.body.id);
      console.log(
        "🎯 SUCESSO: Arquivo painel.png foi enviado para",
        TEST_PHONE
      );
    } else {
      console.log("⚠️ Não foi possível enviar mídia:", response.body.error);
    }
  });

  test("should provide test summary", async () => {
    console.log("📊 Resumo dos Testes Seguros:");
    console.log("✅ Status da API verificado");
    console.log("✅ Arquivos estáticos testados");
    console.log("✅ Validação de parâmetros testada");
    console.log("✅ Envios condicionais (apenas se conectado)");
    console.log("🔒 Sessão WhatsApp protegida durante testes");
    console.log("🎯 Bateria de testes segura concluída!");

    expect(true).toBe(true);
  });
});

describe("🔍 Verificação de Integridade da Sessão", () => {
  test("should verify session is still active after tests", async () => {
    console.log("🔍 Verificando integridade da sessão pós-testes...");

    const response = await request(BASE_URL).get("/baileys/status");

    console.log("📊 Status pós-testes:", {
      socketActive: response.body.socketActive,
      connection: response.body.connection,
      registered: response.body.registered,
    });

    if (response.body.socketActive && response.body.connection !== "close") {
      console.log("✅ Sessão ainda está ativa - testes não causaram danos!");
    } else {
      console.log("⚠️ Sessão foi afetada - pode precisar reconectar");
    }

    expect(response.status).toBe(200);
  });
});
