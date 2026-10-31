import { NextResponse } from "next/server";
import { distribuerFondsDeTest, faucetAvailable } from "@/lib/sirius/faucet";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { AppError } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

/**
 * Le rationnement compte autant que la distribution : la réserve d'ETH est finie et
 * un seul visiteur en boucle la viderait pour tous les autres. Une demande par heure
 * et par compte suffit largement — mille USDC couvrent des centaines d'emprunts.
 */
// Le plafond global borne ce que l'instance peut perdre en une heure, quel que soit le
// nombre d'adresses : avec des comptes créés en un clic, l'adresse n'est plus une
// contrainte. À 0,0002 ETH la distribution, trente par heure font 0,006 ETH — un
// incident coûte une soirée, pas la réserve.
const faucetLimiter = new FixedWindowRateLimiter({
  windowMs: 60 * 60_000,
  maxPerKey: 1,
  maxGlobal: 30,
});
const faucetClientLimiter = new FixedWindowRateLimiter({
  windowMs: 60 * 60_000,
  maxPerKey: 10,
  maxGlobal: 1_200,
});

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    if (!faucetAvailable()) {
      throw new AppError("Distribution de fonds de test indisponible sur cette instance", 503);
    }
    // Clé de limitation sur l'adresse de session, pas sur l'IP seule : l'adresse est
    // ce que l'on sert, et elle a été prouvée par signature au moment de la connexion.
    enforceRateLimit(faucetLimiter, `subject:${session.address}`);
    enforceRateLimit(faucetClientLimiter, requestClientKey(req));
    return NextResponse.json(await distribuerFondsDeTest(session.address));
  } catch (err) {
    return errorResponse(err);
  }
}
