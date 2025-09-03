# Medicit WhatsApp API

### 📁 Estrutura dos Arquivos

```
src/
├── server.ts         # Arquivo principal - coordena todos os módulos
├── config.ts         # Configurações da aplicação
├── logger.ts         # Sistema de logging centralizado
├── initWa.ts         # Inicialização e gerenciamento do WhatsApp/Baileys
├── pairing.ts        # Lógica de pareamento de dispositivos
├── message.ts        # Manipulação de mensagens (envio/recebimento)
├── routes.ts         # Rotas da API Express
├── external.ts       # Integração com endpoints externos
└── shutdown.ts       # Gerenciamento de desligamento graceful
```

## 📋 Descrição dos Módulos

### 🔧 `config.ts`

- **Responsabilidade**: Centraliza todas as configurações da aplicação
- **Conteúdo**:
  - Variáveis de ambiente (PORT, LOG_LEVEL, etc.)
  - Constantes de pareamento (timeouts, tentativas)
  - Constantes de reconexão
  - Configuração de endpoints externos

### 📝 `logger.ts`

- **Responsabilidade**: Sistema de logging unificado
- **Funcionalidades**:
  - `logInfo()` - Logs informativos
  - `logError()` - Logs de erro
  - `logConnectionUpdateFase()` - Logs específicos de conexão
  - `flushPending()` - Processa logs pendentes
  - Sistema de logs pendentes para antes do logger estar pronto

### 🔌 `initWa.ts`

- **Responsabilidade**: Inicialização e gerenciamento do WhatsApp/Baileys
- **Funcionalidades**:
  - `startBaileys()` - Inicializa a conexão WhatsApp
  - `cleanupCurrentSocket()` - Limpeza do socket
  - `resetSession()` - Reset completo da sessão
  - `getConnectionStatus()` - Status da conexão
  - Gerenciamento de reconexões automáticas
  - Processamento de eventos do Baileys

### 🔗 `pairing.ts`

- **Responsabilidade**: Gerenciamento de pareamento de dispositivos
- **Funcionalidades**:
  - `generatePairingCode()` - Gera códigos de pareamento
  - `attemptAutoPair()` - Tentativas automáticas de pareamento
  - `schedulePairingRefresh()` - Agendamento de refresh
  - `isPairingCodeValid()` - Validação de códigos
  - `getPairingStatus()` - Status do pareamento

### 💬 `message.ts`

- **Responsabilidade**: Manipulação de mensagens
- **Funcionalidades**:
  - `enhanceSocketWithMessageLogging()` - Adiciona logging ao socket
  - `formatNumberToJid()` - Formatação de números
  - `extractTextContent()` - Extração de texto
  - `logSimple()` - Log simplificado de mensagens
  - Utilitários para JIDs (isDirectJid, isGroupJid, etc.)

### 🛣️ `routes.ts`

- **Responsabilidade**: Definição das rotas da API
- **Rotas**:
  - `POST /baileys/send-text` - Envio de texto
  - `POST /baileys/send-media` - Envio de mídia
  - `GET /baileys/pair` - Geração de código de pareamento
  - `POST /baileys/reset` - Reset da sessão
  - `GET /baileys/status` - Status da aplicação

### 🌐 `external.ts`

- **Responsabilidade**: Integração com sistemas externos
- **Funcionalidades**:
  - `trySendExternalMessage()` - Envio de mensagens para endpoint externo
  - `trySendExternalStatus()` - Envio de status para endpoint externo
  - `postExternal()` - Função base para requisições externas

### 🔄 `shutdown.ts`

- **Responsabilidade**: Gerenciamento de desligamento graceful
- **Funcionalidades**:
  - `gracefulShutdown()` - Desligamento limpo
  - `bindProcessSignals()` - Binding de sinais do sistema
  - Preservação/limpeza de sessão baseada no status
  - Timeout de segurança para desligamento forçado

### 🚀 `server.ts`

- **Responsabilidade**: Coordenação geral e inicialização
- **Funcionalidades**:
  - Inicialização do Express e Socket.IO
  - Configuração de CORS
  - Coordenação dos módulos
  - Inicialização do logger e WhatsApp

## 🔄 Fluxo de Funcionamento

1. **Inicialização** (`server.ts`):

   - Cria servidor Express e Socket.IO
   - Inicializa logger
   - Configura rotas
   - Inicia WhatsApp
   - Configura sinais de processo

2. **WhatsApp** (`initWa.ts`):

   - Carrega dependências do Baileys
   - Configura autenticação
   - Processa eventos (conexão, mensagens, etc.)
   - Gerencia reconexões automáticas

3. **Pareamento** (`pairing.ts`):

   - Gera códigos quando necessário
   - Gerencia cache de códigos
   - Tentativas automáticas em sessões não registradas

4. **Mensagens** (`message.ts`):

   - Intercepta envios para logging
   - Formata números e JIDs
   - Integra com sistema externo

5. **Logging** (`logger.ts`):
   - Centraliza todos os logs
   - Gerencia logs pendentes
   - Formatação consistente

## ✅ Benefícios da Refatoração

- **Manutenibilidade**: Código organizado em responsabilidades específicas
- **Testabilidade**: Módulos independentes facilitam testes unitários
- **Reutilização**: Funções podem ser importadas onde necessário
- **Debugging**: Problemas localizados mais facilmente
- **Escalabilidade**: Novos recursos podem ser adicionados em módulos específicos
- **Logs Mantidos**: Todos os logs originais foram preservados
- **Funcionalidades Preservadas**: 100% das funcionalidades originais mantidas

## 🔧 Como Usar

```bash
# Instalação de Dependencias
npm install

# Desenvolvimento
npm run dev

# Build
npm run build

# Produção
npm start
```
