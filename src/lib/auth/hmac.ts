import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Jeton signé sans état : `<payloadB64url>.<hmacB64url>`. La clé HMAC est dérivée
 * de SIRIUS_SESSION_SECRET, séparée des secrets détenus par le runner confidentiel.
 */
function sessionSecret(): Buffer {
  const encoded = process.env.SIRIUS_SESSION_SECRET;
  if (!encoded) throw new Error("SIRIUS_SESSION_SECRET manquante");
  const secret = Buffer.from(encoded, "base64");
  if (secret.length !== 32) throw new Error("SIRIUS_SESSION_SECRET invalide");
  return secret;
}

function macOf(body: string, context: string): string {
  return createHmac("sha256", sessionSecret()).update(context).update("\0").update(body).digest("base64url");
}

export function signToken(payload: object, context: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${macOf(body, context)}`;
}

/** Renvoie le payload si le HMAC est valide (comparaison à temps constant), sinon null. */
export function verifyToken<T>(token: string, context: string): T | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = macOf(body, context);
  const received = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length || !timingSafeEqual(received, expectedBuffer)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}
