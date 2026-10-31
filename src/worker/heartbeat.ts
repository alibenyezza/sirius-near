import type { ReaperPassResult } from "@/lib/sirius/reaper";

/**
 * Ligne de vie du reaper, lue par deploy/vps/check-reaper.sh et par l'astreinte.
 *
 * « passe ok » n'est écrite que pour une passe qui a abouti : une passe qui lève (base ou
 * RPC indisponible) ou dont chaque prêt examiné reste en erreur écrit « passe échouée »,
 * que le contrôle refuse. Un reaper vivant mais inopérant ne paraît donc plus sain.
 */
export function reaperHeartbeat(result: ReaperPassResult | null, at: Date): { ok: boolean; line: string } {
  const date = at.toISOString();
  if (!result) return { ok: false, line: `[reaper] passe échouée ${date} : passe interrompue` };
  const detail = `prêts=${result.examined} erreurs=${result.failed}`;
  if (result.examined > 0 && result.failed >= result.examined) {
    return { ok: false, line: `[reaper] passe échouée ${date} ${detail}` };
  }
  return { ok: true, line: `[reaper] passe ok ${date} ${detail}` };
}
