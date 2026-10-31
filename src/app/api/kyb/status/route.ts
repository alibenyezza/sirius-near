import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { AppError } from "@/lib/app-error";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { autoInviteEnabled } from "@/lib/kyb/auto-invite";

export const runtime = "nodejs";

// Lecture seule, propre au wallet de la session : l'adresse ne vient jamais de la requête.
const NO_STORE = { "cache-control": "private, no-store" };
const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 30, maxGlobal: 300 });

/**
 * État KYB du wallet connecté, lu sur le registre (source de vérité) pour la page /kyb :
 * validité (`isKybValid`, qui tient compte de l'expiration et de la révocation) et date
 * d'expiration de l'attestation. Aucune écriture, aucune donnée d'un autre wallet.
 * `instantAccess` dit si la page peut proposer l'accès instantané (drapeau serveur, lu à
 * l'exécution : le couper ne demande aucun rebuild).
 */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(limiter, `subject:${session.address}`);
    const client = getPublicClient();
    const address = session.address as `0x${string}`;
    const registry = kybRegistryAddress();
    const [valid, attestation] = await Promise.all([
      client.readContract({ address: registry, abi: siriuskybregistryAbi, functionName: "isKybValid", args: [address] }),
      client.readContract({ address: registry, abi: siriuskybregistryAbi, functionName: "attestationOf", args: [address] }),
    ]).catch(() => { throw new AppError("Statut de vérification indisponible", 503); });
    const attested = attestation.verifier !== "0x0000000000000000000000000000000000000000";
    return NextResponse.json(
      {
        valid, expiresAt: attested ? Number(attestation.expiresAt) : null, revoked: attested && attestation.revoked,
        instantAccess: autoInviteEnabled(),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
