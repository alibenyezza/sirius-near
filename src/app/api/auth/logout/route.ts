import { NextResponse } from "next/server";
import { assertMutationOrigin } from "@/lib/auth/origin";
import { clearSession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  assertMutationOrigin(req);
  const res = NextResponse.json({ ok: true });
  clearSession(res);
  return res;
}
