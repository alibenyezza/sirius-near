import "server-only";
import type { NextResponse } from "next/server";
import { signToken, verifyToken } from "./hmac";

const CTX = "sirius-session";
const COOKIE = "sirius_session";
// Même durée que la délégation runner : une session ne survit pas à sa délégation.
const TTL_MS = 24 * 60 * 60 * 1000;

export type SessionSource = "external";
export interface Session {
  address: string;
  source: SessionSource;
}
interface SessionPayload extends Session {
  iat: number;
  exp: number;
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
});

export function setSession(res: NextResponse, session: Session): void {
  const now = Date.now();
  const token = signToken({ ...session, iat: now, exp: now + TTL_MS }, CTX);
  res.cookies.set(COOKIE, token, { ...cookieOptions(), maxAge: TTL_MS / 1000 });
}

export function readSession(req: Request): Session | null {
  const token = parseCookie(req.headers.get("cookie"), COOKIE);
  if (!token) return null;
  const p = verifyToken<SessionPayload>(token, CTX);
  if (!p || Date.now() > p.exp) return null;
  return { address: p.address, source: p.source };
}

export function clearSession(res: NextResponse): void {
  res.cookies.set(COOKIE, "", { ...cookieOptions(), maxAge: 0 });
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
