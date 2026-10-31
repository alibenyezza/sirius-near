import "server-only";
import { readSession, type Session } from "./session";
import { AppError } from "@/lib/errors";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertMutationOrigin } from "./origin";
import { addressesEqual } from "@/lib/evm/address";
import { authenticateRunnerGrant } from "@/lib/runner/authorization";

/** Garde de route : renvoie la session ou lève un 401 (rattrapé par errorResponse). */
export function requireAuth(req: Request): Session {
  assertMutationOrigin(req);
  const session = readSession(req);
  if (!session) throw new AppError("Authentification requise", 401);
  return session;
}

/** Contrôle de propriété : la session doit correspondre à l'adresse propriétaire, sinon 403. */
export function assertOwner(session: Session, owner: string): void {
  if (!addressesEqual(session.address, owner)) throw new AppError("Accès refusé : ressource d'un autre compte", 403);
}

export function assertGrantSubject(session: Session, grant: RunnerGrant): void {
  if (!addressesEqual(grant.payload?.subject, session.address)) {
    throw new AppError("Le grant runner ne correspond pas au wallet connecté", 403);
  }
}

/**
 * Garde complète avant tout appel runner : le grant appartient au wallet connecté ET ses
 * signatures sont valides. Un grant forgé ou expiré s'arrête ici, sans consommer de
 * budget runner ni compter d'échec dans son coupe-circuit.
 */
export async function assertAuthenticGrant(session: Session, grant: RunnerGrant): Promise<void> {
  assertGrantSubject(session, grant);
  const { subject } = await authenticateRunnerGrant(grant);
  if (!addressesEqual(subject, session.address)) {
    throw new AppError("Le grant runner ne correspond pas au wallet connecté", 403);
  }
}
