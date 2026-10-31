import "server-only";
import { randomBytes } from "node:crypto";
import { signToken, verifyToken } from "./hmac";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/db";
import { buildDelegationMessage, parseDelegationMessage } from "@/lib/runner/authorization-contract";

const CTX = "sirius-auth-challenge";
const TTL_MS = 5 * 60 * 1000;
// 24 h : une signature obtenue par hameçonnage ne donne la main sur la session runner
// que pour une journée, au lieu d'une semaine (audit M2). Le runner accepte jusqu'à 7 jours.
const DELEGATION_TTL_MS = 24 * 60 * 60 * 1000;

interface ChallengePayload {
  a: string;
  o: string;
  k: string;
  net: string;
  diat: number;
  dexp: number;
  n: string;
  iat: number;
  exp: number;
}

/**
 * Challenge signé, associé à un nonce persistant consommé à la vérification.
 */
export async function createChallenge(
  address: string,
  origin: string,
  sessionPublicKey: string,
  network: string,
): Promise<{ challenge: string; delegationExpiresAt: number }> {
  const now = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const delegationExpiresAt = now + DELEGATION_TTL_MS;
  const token = signToken(
    {
      a: address,
      o: origin,
      k: sessionPublicKey,
      net: network,
      diat: now,
      dexp: delegationExpiresAt,
      n: nonce,
      iat: now,
      exp: now + TTL_MS,
    },
    CTX,
  );
  return {
    challenge: buildDelegationMessage({
      origin,
      address,
      sessionPublicKey,
      network,
      issuedAt: now,
      expiresAt: delegationExpiresAt,
      challengeToken: token,
    }),
    delegationExpiresAt,
  };
}

export async function verifyChallenge(challenge: string, address: string, origin: string): Promise<void> {
  const fields = parseDelegationMessage(challenge);
  if (!fields || fields.origin !== origin || fields.address !== address) throw new AppError("Challenge invalide", 401);
  const p = verifyToken<ChallengePayload>(fields.challengeToken, CTX);
  if (
    !p ||
    p.a !== address ||
    p.o !== origin ||
    p.k !== fields.sessionPublicKey ||
    p.net !== fields.network ||
    p.diat !== fields.issuedAt ||
    p.dexp !== fields.expiresAt
  ) {
    throw new AppError("Challenge invalide", 401);
  }
  if (Date.now() > p.exp) throw new AppError("Challenge expiré", 401);
  try {
    await prisma.authChallenge.create({ data: { nonce: p.n, address, expiresAt: new Date(p.exp) } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new AppError("Challenge invalide ou déjà utilisé", 401);
    throw error;
  }
  await prisma.authChallenge.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}
