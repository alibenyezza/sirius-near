import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { ensureUserProfileWithin, MAX_PROFILE_PATCH_CHARS, updateUserProfile } from "@/lib/users/profile";

export const runtime = "nodejs";

// Le profil d'un wallet est privé : l'adresse vient de la session signée, jamais du corps
// ni des paramètres, et aucune réponse n'est mise en cache.
const NO_STORE = { "cache-control": "private, no-store" };

const readLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 60, maxGlobal: 1_000 });
const writeLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 400 });

// Marge au-dessus de la borne du module : un corps plus gros est refusé avant d'être lu.
const MAX_PATCH_BODY_BYTES = 2 * MAX_PROFILE_PATCH_CHARS;

/**
 * Profil du wallet connecté, créé à la volée s'il manque (session ouverte avant la migration).
 * L'upsert porte ses délais PostgreSQL : une ligne verrouillée ne retient pas une connexion du pool.
 */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(readLimiter, `subject:${session.address}`);
    return NextResponse.json(await ensureUserProfileWithin(session.address), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Modification validée : tutos et réglages seulement, KYB et blocage jamais. */
export async function PATCH(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(writeLimiter, `subject:${session.address}`);
    const patch = await readJson<Record<string, unknown>>(req, MAX_PATCH_BODY_BYTES);
    return NextResponse.json(await updateUserProfile(session.address, patch), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
