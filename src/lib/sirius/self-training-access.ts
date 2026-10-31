import "server-only";
import { AppError } from "@/lib/app-error";
import { adminAllowed } from "@/lib/auth/admin";
import type { Session } from "@/lib/auth/session";

/**
 * Message renvoyé à un wallet qui n'a pas accès au self training. Volontairement pauvre :
 * il ne confirme ni l'existence de la fonction, ni la raison du refus, ni la liste des accès.
 */
export const SELF_TRAINING_UNAVAILABLE = "Bientôt disponible";

/**
 * Instance de démonstration Phala ([12](docs/passage-mainnet/12-test-phala.md)) : la démo
 * publique EST un self training sur ses propres données, porté par les mêmes routes
 * `/api/train`. Mêmes conditions que `demoEnabled` dans `src/lib/phala-demo/runner-session.ts`
 * (drapeau exact, testnet, enclave Phala sans simulateur), mais sans lever : une configuration
 * incomplète ferme simplement l'exception. La démo n'existe que sur le testnet ;
 * `requiresPhalaRunner` refuse de démarrer une démo hors testnet, et cette fonction l'exige une
 * seconde fois. Sur mainnet, elle renvoie donc toujours faux : aucune exemption en production.
 */
export function phalaDemoInstance(env: Record<string, string | undefined> = process.env): boolean {
  return env.SIRIUS_PHALA_DEMO === "true" && env.EVM_NETWORK === "testnet" && env.TEE_MODE === "phala"
    && !env.DSTACK_SIMULATOR_ENDPOINT;
}

/**
 * Un grant runner émis par le parcours de démo porte la révision de session de la démo : un
 * entier strictement positif (la première ouverture porte la révision 1). Ce champ n'est pas
 * authentifié ici : il ne sert qu'à reconnaître un entraînement de démo. Le grant est ensuite
 * authentifié par `assertAuthenticGrant`, et le runner refuse toute révision qui n'est pas celle
 * de la session ouverte.
 */
export function isDemoTrainingGrant(grant: unknown): boolean {
  if (typeof grant !== "object" || grant === null) return false;
  const payload = (grant as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return false;
  const revision = (payload as { demoSessionRevision?: unknown }).demoSessionRevision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0;
}

export function selfTrainingUnavailable(): AppError {
  return new AppError(SELF_TRAINING_UNAVAILABLE, 403);
}

/**
 * Garde côté serveur de toutes les routes de self training. À appeler juste après
 * `requireAuth`, avant toute lecture de corps, toute requête en base, toute vérification de
 * grant et tout appel runner : un refus ne coûte rien et ne consomme aucun budget runner.
 *
 * - Administrateur (`SIRIUS_ADMIN_ADDRESSES`) : accès.
 * - Sinon, uniquement si `demoAccess` est vrai ET que l'instance est une démo Phala sur
 *   testnet : la part publique de la démo (liste des jobs, entraînement porté par un grant
 *   de démo) reste accessible aux visiteurs, comme avant cette garde.
 * - Sinon : 403 « Bientôt disponible ».
 */
export function assertSelfTrainingAccess(session: Session, demoAccess = false): void {
  if (adminAllowed(session.address)) return;
  if (demoAccess && phalaDemoInstance()) return;
  throw selfTrainingUnavailable();
}
