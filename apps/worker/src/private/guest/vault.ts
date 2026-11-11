import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { guestCheck, guestObject } from "./config.js";

export function privateGuestFile(path: string): unknown {
  const stat = lstatSync(path);
  guestCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096, "guest_secret_file_invalid");
  if (process.platform !== "win32") guestCheck((stat.mode & 0o077) === 0, "guest_secret_file_permissions");
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("guest_secret_file_invalid"); }
}
export class GuestVault {
  private readonly key: Buffer;
  readonly keyId: string;
  readonly path: string;
  constructor(filename: string) {
    this.path = realpathSync(filename);
    const r = guestObject(privateGuestFile(filename), ["key_base64"]);
    guestCheck(typeof r["key_base64"] === "string" && /^[A-Za-z0-9+/]{43}=$/.test(r["key_base64"]));
    this.key = Buffer.from(r["key_base64"], "base64"); guestCheck(this.key.length === 32);
    this.keyId = createHash("sha256").update(this.key).digest("hex");
  }
  seal(secret: string, context: string): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }
  open(encrypted: string, context: string): string {
    const body = Buffer.from(encrypted, "base64"); guestCheck(body.length >= 28 && body.length <= 16384);
    const decipher = createDecipheriv("aes-256-gcm", this.key, body.subarray(0, 12));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(body.subarray(12, 28));
    return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]).toString("utf8");
  }
  hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
  hmac(value: string): string { return createHmac("sha256", this.key).update(value).digest("hex"); }
  close(): void { this.key.fill(0); }
}
