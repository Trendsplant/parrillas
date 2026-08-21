import crypto from "node:crypto";

export const DEFAULT_SHOP = "trendsplant-apparel-for-the-modern-nomad";

function key() {
  const secret = String(process.env.SESSION_SECRET || "").trim();
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET debe estar configurada con al menos 32 caracteres.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag(),
  ]);
  return Buffer.concat([iv, encrypted]).toString("base64url");
}

export function open(value) {
  try {
    const payload = Buffer.from(String(value || ""), "base64url");
    if (payload.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(-16));
    return JSON.parse(Buffer.concat([
      decipher.update(payload.subarray(12, -16)), decipher.final(),
    ]).toString());
  } catch {
    return null;
  }
}

export function validOAuthHmac(query = {}) {
  const secret = String(process.env.SHOPIFY_API_SECRET || "");
  const provided = String(query.hmac || "");
  if (!secret || !/^[a-f0-9]{64}$/i.test(provided)) return false;
  const message = Object.entries(query)
    .filter(([name]) => name !== "hmac" && name !== "signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => name + "=" + (Array.isArray(value) ? value.join(",") : String(value)))
    .join("&");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}
