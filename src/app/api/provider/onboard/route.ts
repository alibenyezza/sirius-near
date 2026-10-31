import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { finalizeKybAcceptance, prepareKybAcceptance } from "@/lib/sirius/kyb";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    const { invitation } = await readJson<{ invitation?: unknown }>(req);
    return NextResponse.json(await prepareKybAcceptance(session.address, invitation));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const session = requireAuth(req);
    const { txHash } = await readJson<{ txHash?: unknown }>(req);
    if (txHash !== undefined && typeof txHash !== "string") {
      return NextResponse.json({ error: "Hash de transaction KYB invalide" }, { status: 400 });
    }
    return NextResponse.json(await finalizeKybAcceptance(session.address, txHash));
  } catch (err) {
    return errorResponse(err);
  }
}
