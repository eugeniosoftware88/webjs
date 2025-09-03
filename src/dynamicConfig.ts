import { promises as fs } from "fs";
import path from "path";
import { logInfo, logError } from "./logger";

interface DynamicConfigData {
  PAIR_PHONE?: string;
  EXTERNAL_ENDPOINT?: string;
}

class DynamicConfigManager {
  private configFilePath: string;
  private config: DynamicConfigData = {};
  private pairingAttempts: { timestamp: number }[] = [];
  private readonly PAIRING_WINDOW_MS = 60 * 60 * 1000; // 1 hora
  private readonly MAX_PAIRING_ATTEMPTS = 4;

  constructor() {
    this.configFilePath = path.join(process.cwd(), "dynamic-config.json");
    this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    try {
      const exists = await fs
        .access(this.configFilePath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        const data = await fs.readFile(this.configFilePath, "utf-8");
        this.config = JSON.parse(data);
      }
    } catch (error) {
      logError("Erro ao carregar configuracoes dinamicas", error);
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      await fs.writeFile(
        this.configFilePath,
        JSON.stringify(this.config, null, 2)
      );
      logInfo("Configuracoes dinamicas salvas");
    } catch (error) {
      logError("Erro ao salvar configuracoes dinamicas", error);
    }
  }

  public async updateConfig(
    newConfig: Partial<DynamicConfigData>
  ): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    await this.saveConfig();
  }

  public getConfig(): DynamicConfigData {
    return { ...this.config };
  }

  public getPairPhone(): string | undefined {
    return this.config.PAIR_PHONE;
  }

  public getExternalEndpoint(): string | undefined {
    return this.config.EXTERNAL_ENDPOINT;
  }

  public addPairingAttempt(): void {
    const now = Date.now();
    this.pairingAttempts.push({ timestamp: now });

    this.pairingAttempts = this.pairingAttempts.filter(
      (attempt) => now - attempt.timestamp < this.PAIRING_WINDOW_MS
    );
  }

  public canRequestPairingCode(): boolean {
    const now = Date.now();
    const recentAttempts = this.pairingAttempts.filter(
      (attempt) => now - attempt.timestamp < this.PAIRING_WINDOW_MS
    );

    return recentAttempts.length < this.MAX_PAIRING_ATTEMPTS;
  }

  public getPairingAttemptsCount(): number {
    const now = Date.now();
    return this.pairingAttempts.filter(
      (attempt) => now - attempt.timestamp < this.PAIRING_WINDOW_MS
    ).length;
  }

  public getRemainingPairingAttempts(): number {
    return Math.max(
      0,
      this.MAX_PAIRING_ATTEMPTS - this.getPairingAttemptsCount()
    );
  }

  public getTimeUntilPairingReset(): number {
    if (this.pairingAttempts.length === 0) return 0;

    const oldestAttempt = Math.min(
      ...this.pairingAttempts.map((a) => a.timestamp)
    );
    const resetTime = oldestAttempt + this.PAIRING_WINDOW_MS;

    return Math.max(0, resetTime - Date.now());
  }
}

export const dynamicConfig = new DynamicConfigManager();
