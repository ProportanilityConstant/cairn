import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM encryption for the secret store. Key derived from CAIRN_SECRET_KEY. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secretKey: string) {
    this.key = createHash("sha256").update(secretKey, "utf8").digest();
  }

  encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: enc.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

 decrypt(rec: { ciphertext: string; iv: string; tag: string }): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(rec.iv, "base64"));
    decipher.setAuthTag(Buffer.from(rec.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(rec.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}
