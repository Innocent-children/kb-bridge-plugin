export type FileIntentKey = { accountId?: string; sessionKey?: string; senderId: string };

export class FileIntentStore {
  private readonly intents = new Map<string, number>();

  arm(key: FileIntentKey, ttlMs: number, now = Date.now()): void {
    this.intents.set(this.key(key), now + ttlMs);
  }

  cancel(key: FileIntentKey): boolean {
    return this.intents.delete(this.key(key));
  }

  consume(key: FileIntentKey, now = Date.now()): boolean {
    const encoded = this.key(key);
    const expiresAt = this.intents.get(encoded);
    if (expiresAt === undefined) return false;
    this.intents.delete(encoded);
    return expiresAt > now;
  }

  has(key: FileIntentKey, now = Date.now()): boolean {
    const encoded = this.key(key);
    const expiresAt = this.intents.get(encoded);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.intents.delete(encoded);
      return false;
    }
    return true;
  }

  private key(value: FileIntentKey): string {
    return [value.accountId ?? "", value.sessionKey ?? "", value.senderId].join("\u001f");
  }
}
