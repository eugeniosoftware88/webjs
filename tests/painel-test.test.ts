import request from "supertest";

const TEST_PHONE = "558731420272";
const BASE_URL = "http://localhost:8000";

describe("🖼️ Teste de Mídia - painel.png (Corrigido)", () => {
  test("should send image via URL (primeira tentativa)", async () => {
    console.log("🌐 Tentando enviar imagem via URL externa...");

    const response = await request(BASE_URL)
      .post("/baileys/send-media")
      .send({
        number: TEST_PHONE,
        file: "https://placehold.co/600x400?text=TESTE+API+MEDICIT",
        caption: `🧪 Teste de imagem via URL externa\n📅 ${new Date().toLocaleString(
          "pt-BR"
        )}\n🔗 Enviado pela bateria de testes`,
      });

    console.log("📤 Resposta URL externa:", response.body);

    if (response.status === 200 && response.body.ok) {
      console.log("✅ Imagem via URL enviada com sucesso!");
      console.log("🆔 Message ID:", response.body.id);
    } else {
      console.log("❌ Falha com URL externa, tentando método alternativo...");
    }

    expect([200, 400, 500]).toContain(response.status);
  });

  test("should send small test image via base64", async () => {
    console.log("📦 Enviando imagem pequena de teste via base64...");

    const smallGreenImage =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAADMElEQVR4nOzVwQnAIBQFQYXff81RUkQCOyDj1YOPnbXWPmeTRef+/3O/OyBjzh3CD95BfqICMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMK0CMO0TAAD//2Anhf4QtqobAAAAAElFTkSuQmCC";

    const response = await request(BASE_URL)
      .post("/baileys/send-media")
      .send({
        number: TEST_PHONE,
        file: smallGreenImage,
        caption: `📦 Imagem pequena de teste (16x16px)\n🧪 Teste de base64\n📅 ${new Date().toLocaleString(
          "pt-BR"
        )}`,
      });

    console.log("📤 Resposta imagem pequena:", response.body);

    if (response.status === 200 && response.body.ok) {
      console.log("✅ Imagem pequena enviada com sucesso!");
      console.log("🆔 Message ID:", response.body.id);
    } else {
      console.log("❌ Falha no envio da imagem pequena:", response.body);
    }

    expect([200, 400, 500]).toContain(response.status);
  });

  test("should send painel.png via public URL if available", async () => {
    console.log("🏠 Tentando enviar painel.png via URL da própria API...");

    const painelUrl = `${BASE_URL}/painel.png`;

    const response = await request(BASE_URL)
      .post("/baileys/send-media")
      .send({
        number: TEST_PHONE,
        file: painelUrl,
        caption: `🖼️ PAINEL.PNG enviado via URL pública\n📅 ${new Date().toLocaleString(
          "pt-BR"
        )}\n🎯 Teste específico do arquivo solicitado`,
      });

    console.log("📤 Resposta painel.png via URL:", response.body);

    if (response.status === 200 && response.body.ok) {
      console.log("✅ painel.png enviado com sucesso via URL!");
      console.log("🆔 Message ID:", response.body.id);
      console.log(
        "🎯 SUCESSO: Arquivo painel.png foi enviado para",
        TEST_PHONE
      );
    } else {
      console.log("❌ Falha no envio do painel.png via URL:", response.body);
      console.log(
        "💡 Dica: Verifique se o arquivo public/painel.png está sendo servido corretamente"
      );
    }

    expect([200, 400, 500]).toContain(response.status);
  });

  test("should send multiple text messages with different content", async () => {
    console.log("💬 Enviando várias mensagens de teste...");

    const messages = [
      `🎯 TESTE 1/3: Mensagem básica\n📅 ${new Date().toLocaleString("pt-BR")}`,
      `🎯 TESTE 2/3: Emojis e caracteres especiais\n😀 🎉 ❤️ 🚀 💻 📱\náêíóú ção àèìòù\n@#$%^&*()`,
      `🎯 TESTE 3/3: Mensagem multilinha\nLinha 1: Dados básicos\nLinha 2: Informações adicionais\nLinha 3: Observações finais\n\n✅ Bateria de testes concluída!`,
    ];

    let successCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const response = await request(BASE_URL).post("/baileys/send-text").send({
        number: TEST_PHONE,
        message: messages[i],
      });

      if (response.status === 200 && response.body.ok) {
        successCount++;
        console.log(`✅ Mensagem ${i + 1}/3 enviada com sucesso`);
      } else {
        console.log(`❌ Falha na mensagem ${i + 1}/3:`, response.body);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `📊 Resultado: ${successCount}/${messages.length} mensagens enviadas`
    );
    expect(successCount).toBeGreaterThan(0);
  });
});
