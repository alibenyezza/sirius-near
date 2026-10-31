import "server-only";
import { AppError } from "@/lib/app-error";
import { requireAuth } from "@/lib/auth/require-auth";
import { DEMO_OPERATOR_CODE_HEADER } from "./contract";
import { operatorAllowed } from "./operator";
import { databaseOperatorAttempts } from "./operator-attempts";
import { assertOperatorCode } from "./operator-code";

export async function requireDemoOperator(req: Request): Promise<string> {
  const session = requireAuth(req);
  if (!operatorAllowed(session.address)) throw new AppError("Commande réservée aux opérateurs Sirius", 403);
  await assertOperatorCode(session.address, req.headers.get(DEMO_OPERATOR_CODE_HEADER), databaseOperatorAttempts);
  return session.address;
}
