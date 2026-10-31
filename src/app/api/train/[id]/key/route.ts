import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { selfTrainModelKeyInRunner } from "@/lib/tee/runner-client";
import { assertSelfTrainingAccess } from "@/lib/sirius/self-training-access";
import { assertAuthenticGrant, requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertCurrentRunner } from "@/lib/runner/provenance";

export const runtime = "nodejs";

const keyDeliveryLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 20,
  maxGlobal: 200,
});

/**
 * Re-livre la clé du modèle d'un self-train terminé (dérivée, jamais stockée). Réservé à
 * l'équipe, sans exception de démo : la démo Phala livre ses clés par `/api/phala-demo/results`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    assertSelfTrainingAccess(session);
    enforceRateLimit(keyDeliveryLimiter, `subject:${session.address}`);
    const { id } = await params;
    const { authorization, deliveryPublicKey } = await readJson<{
      authorization?: RunnerGrant;
      deliveryPublicKey?: unknown;
    }>(req);
    if (!authorization || typeof deliveryPublicKey !== "string") {
      return NextResponse.json({ error: "Autorisation ou clé de livraison manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const job = await prisma.trainingJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Job introuvable" }, { status: 404 });
    assertOwner(session, job.owner);
    if (job.status !== "DONE" || !job.modelCid || !job.runnerReceipt) {
      return NextResponse.json({ error: "Modèle pas encore livré" }, { status: 409 });
    }
    await assertCurrentRunner(job);
    const modelKeyEnvelope = await selfTrainModelKeyInRunner(
      id,
      job.runnerReceipt,
      deliveryPublicKey,
      authorization,
    );
    return NextResponse.json({ modelCid: job.modelCid, modelKeyEnvelope });
  } catch (err) {
    return errorResponse(err);
  }
}
