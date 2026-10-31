import { NextResponse } from "next/server";
import { finalizeLoan } from "@/lib/sirius/borrower";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";

export const runtime = "nodejs";

/** Phase 2 : vérifie le lock USDC déjà diffusé par le wallet du borrower. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { lockTxHash } = await readJson<{ lockTxHash?: unknown }>(req);
    if (lockTxHash !== undefined && (typeof lockTxHash !== "string" || !lockTxHash)) {
      return NextResponse.json({ error: "lockTxHash invalide" }, { status: 400 });
    }
    const loan = await finalizeLoan(id, session.address, typeof lockTxHash === "string" ? lockTxHash : undefined);
    return NextResponse.json(loan);
  } catch (err) {
    return errorResponse(err);
  }
}
