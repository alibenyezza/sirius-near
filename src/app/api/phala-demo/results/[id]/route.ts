import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const job = await prisma.trainingJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Résultat introuvable" }, { status: 404 });
    assertOwner(session, job.owner);
    if (job.status !== "DONE" || !job.deliveryEnvelope || !job.deliveryPublicKey || !job.modelCid) {
      return NextResponse.json({ error: "Livraison pas encore disponible" }, { status: 409 });
    }
    return NextResponse.json({ jobId: id, modelCid: job.modelCid, metrics: job.metrics,
      publicKey: job.deliveryPublicKey, envelope: job.deliveryEnvelope, runnerReceipt: job.runnerReceipt },
    { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
