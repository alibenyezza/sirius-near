import { NextResponse } from "next/server";
import { verifyChallenge } from "@/lib/auth/challenge";
import { authenticationOrigin } from "@/lib/auth/origin";
import { verifyLoginSignature } from "@/lib/evm/signature";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { setSession, type SessionSource } from "@/lib/auth/session";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { touchUserProfileAfterLogin } from "@/lib/users/profile";

export const runtime = "nodejs";

const SOURCES: SessionSource[] = ["external"];
const verifyLimiter = new FixedWindowRateLimiter({
  windowMs: 5 * 60_000,
  maxPerKey: 20,
  maxGlobal: 300,
});

export async function POST(req: Request) {
  try {
    const origin = authenticationOrigin(req);
    const { address, signature, message, source } = await readJson<Record<string, unknown>>(req);

    if ([address, signature, message].some((v) => typeof v !== "string" || !v)) {
      return NextResponse.json({ error: "Requête incomplète" }, { status: 400 });
    }
    if (typeof source !== "string" || !SOURCES.includes(source as SessionSource)) {
      return NextResponse.json({ error: "Source invalide" }, { status: 400 });
    }
    const authenticatedSource = source as SessionSource;
    const authenticatedAddress = address as string;
    const authenticatedSignature = signature as string;
    const authenticatedMessage = message as string;
    const normalizedAddress = tryNormalizeAddress(authenticatedAddress);
    if (!normalizedAddress) return NextResponse.json({ error: "Adresse invalide" }, { status: 400 });
    enforceRateLimit(verifyLimiter, requestClientKey(req, normalizedAddress));

    // Le challenge lie la string signée à `address` (HMAC + non-expiré) ; la
    // signature prouve la possession de la clé. Les deux échouent en 401.
    const verifiedAddress = await verifyLoginSignature({
      address: normalizedAddress,
      signature: authenticatedSignature,
      message: authenticatedMessage,
    });
    await verifyChallenge(authenticatedMessage, verifiedAddress, origin);
    // Profil créé ou daté après la preuve de possession ; une panne de base n'empêche
    // jamais la connexion et ne journalise que la classe de l'erreur.
    await touchUserProfileAfterLogin(verifiedAddress);

    const res = NextResponse.json({ address: verifiedAddress, source: authenticatedSource });
    setSession(res, { address: verifiedAddress, source: authenticatedSource });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
