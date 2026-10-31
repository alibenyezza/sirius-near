import { NextResponse } from "next/server";
import { assertAuthenticGrant, requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { withUploadAdmission } from "@/lib/http/upload-admission";
import { authorizeDatasetUpload, completeDatasetIngestion } from "@/lib/sirius/pipeline";
import {
  MAX_DATASET_BYTES,
  type DatasetIngressEnvelope,
} from "@/lib/tee/contract";
import { parseRunnerGrantHeader } from "@/lib/runner/authorization-contract";

export const runtime = "nodejs";

const MAX_ENVELOPE_BYTES = Math.ceil(((MAX_DATASET_BYTES + 16) * 4) / 3) + 8 * 1024;
const UPLOAD_TIMEOUT_MS = 30_000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const authorization = parseRunnerGrantHeader(req.headers.get("x-sirius-runner-grant"));
    if (!authorization) {
      return NextResponse.json({ error: "Autorisation runner manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    return await withUploadAdmission(session.address, async () => {
      const dataset = await authorizeDatasetUpload(id, session.address);
      const { envelope } = await readJson<{
        envelope?: DatasetIngressEnvelope;
      }>(req, MAX_ENVELOPE_BYTES, { requireContentLength: true, timeoutMs: UPLOAD_TIMEOUT_MS });
      if (!envelope) {
        return NextResponse.json({ error: "Enveloppe manquante" }, { status: 400 });
      }
      return NextResponse.json(await completeDatasetIngestion(dataset, envelope, authorization));
    });
  } catch (err) {
    return errorResponse(err);
  }
}
