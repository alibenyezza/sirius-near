import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { prisma } from "@/lib/db";
import { fetchFromIpfs } from "@/lib/ipfs/pinata";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const modelDownloadLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 20,
  maxGlobal: 200,
});

function validCid(cid: string): boolean {
  return /^[A-Za-z0-9]{16,256}$/.test(cid);
}

export async function GET(req: Request, { params }: { params: Promise<{ cid: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(modelDownloadLimiter, `subject:${session.address}`);
    const { cid } = await params;
    if (!validCid(cid)) return NextResponse.json({ error: "CID de modèle invalide" }, { status: 400 });

    const [loan, job] = await Promise.all([
      prisma.loan.findFirst({
        where: { borrower: session.address, status: "SETTLED", modelCid: cid },
        select: { id: true },
      }),
      prisma.trainingJob.findFirst({
        where: { owner: session.address, status: "DONE", modelCid: cid },
        select: { id: true },
      }),
    ]);
    if (!loan && !job) return NextResponse.json({ error: "Modèle introuvable" }, { status: 404 });

    return new NextResponse(new Uint8Array(await fetchFromIpfs(cid)), {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
