console.log("🚀 Iniciando configuração dos testes...");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.WA_LOG_LEVEL = "error";
process.env.LOG_CONN_VERBOSE = "false";
process.env.LOG_WA_MESSAGES = "false";

const TEST_CONFIG = {
  BASE_URL: "http://localhost:8000",
  TEST_PHONE: "558731420272",
  TIMEOUT: 30000,
};

(global as any).TEST_CONFIG = TEST_CONFIG;

console.log("✅ Configuração dos testes concluída");
console.log(`📱 Número de teste: ${TEST_CONFIG.TEST_PHONE}`);
console.log(`🌐 URL base: ${TEST_CONFIG.BASE_URL}`);
console.log(`⏱️  Timeout: ${TEST_CONFIG.TIMEOUT}ms`);
