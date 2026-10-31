import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    { error: "La capsule EVM doit être persistée avant le règlement ; relance le job si elle a été perdue." },
    { status: 409 },
  );
}
