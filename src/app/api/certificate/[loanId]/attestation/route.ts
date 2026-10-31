import { loadCertificate } from "@/lib/certificate/load";
import { certificateDownloadResponse } from "@/lib/certificate/download";

export const runtime = "nodejs";

/**
 * Attestation brute d'un certificat d'exécution, publique et en lecture seule (voir
 * `src/lib/certificate/download.ts`). Même règle d'accès que la page `/certificate/[loanId]`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params;
  return certificateDownloadResponse(req, loanId, loadCertificate);
}
