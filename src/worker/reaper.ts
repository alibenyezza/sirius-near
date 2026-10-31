import { formatEther } from "viem";
import { runLoanReaper } from "@/lib/sirius/reaper";
import { createWithdrawRelayer, WITHDRAW_RELAYER_INTERVAL_MS, withdrawRelayerConfig } from "@/lib/sirius/withdraw-relayer";
import { requireReaperEvmDeployment } from "@/lib/evm/deployment";
import { AppError } from "@/lib/app-error";
import { assertReaperRunnerConfiguration } from "@/lib/runner/config";
import { assertReaperMainnetConfiguration } from "./mainnet-guard";
import { reaperHeartbeat } from "./heartbeat";
import { purgeExpiredAccessLogs } from "@/lib/users/access-log-retention";
import { databaseAccessLogRetention } from "@/lib/users/access-log-store";
import { purgeExpiredAutoInvites } from "@/lib/kyb/auto-invite-retention";
import { databaseAutoInviteRetention } from "@/lib/sirius/kyb-auto-invite";

/**
 * Reaper autonome, destiné à tourner en conteneur sur le VPS.
 *
 * L'application Next est hébergée en serverless : elle n'a aucun processus qui vive
 * entre deux requêtes, donc nulle part où réconcilier les prêts en arrière-plan. Ce
 * point d'entrée est ce processus permanent, et il attaque la même base.
 *
 * Deux différences avec le démarrage en cours de processus utilisé en développement :
 *
 *   - La boucle est séquentielle. Un `setInterval` relance à échéance fixe même si la
 *     passe précédente n'est pas terminée ; sur une base lente ou un lot de prêts qui
 *     traîne, les exécutions se recouvrent et se disputent les mêmes lignes. Ici la
 *     pause ne commence qu'une fois la passe finie.
 *
 *   - Le processus reste vivant. En développement le timer est `unref`é pour ne pas
 *     retenir Next ; ici c'est exactement l'inverse qu'on veut.
 */

const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 300_000;

function resolveInterval(): number {
  const interval = Number(process.env.SIRIUS_REAPER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
    throw new AppError(
      `SIRIUS_REAPER_INTERVAL_MS invalide : attendu un entier entre ${MIN_INTERVAL_MS} et ${MAX_INTERVAL_MS} ms`,
    );
  }
  return interval;
}

let arret = false;
let reveil: (() => void) | null = null;

/** Pause interruptible : un signal d'arrêt n'attend pas la fin du délai. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      reveil = null;
      resolve();
    }, ms);
    reveil = () => {
      clearTimeout(timer);
      reveil = null;
      resolve();
    };
  });
}

function demanderArret(signal: string): void {
  if (arret) return;
  arret = true;
  console.log(`[reaper] ${signal} reçu — arrêt après la passe en cours`);
  reveil?.();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => demanderArret(signal));
}

async function main(): Promise<void> {
  const interval = resolveInterval();
  assertReaperMainnetConfiguration();
  assertReaperRunnerConfiguration();
  await requireReaperEvmDeployment();
  const relayerConfig = withdrawRelayerConfig();
  const relayer = relayerConfig && createWithdrawRelayer(relayerConfig);
  console.log(`[reaper] démarré, une passe toutes les ${interval} ms`);
  if (relayerConfig) {
    console.log(`[withdraw-relayer] actif avec ${relayerConfig.account.address} : seuil ${relayerConfig.minimumUsdc} USDC, plafond ${formatEther(relayerConfig.dailyGasWei)} ETH par jour`);
  }
  let dernierRelais = -Infinity;

  while (!arret) {
    const debut = Date.now();
    let bilan: Awaited<ReturnType<typeof runLoanReaper>> | null = null;
    try {
      bilan = await runLoanReaper();
    } catch {
      // Une passe qui échoue ne doit pas tuer le worker : la cause est presque
      // toujours transitoire — base indisponible, RPC qui refuse. La passe suivante
      // reprendra les mêmes prêts, puisque rien n'a été marqué comme traité.
      console.error("[reaper] passe échouée, reprise à la suivante");
    }
    if (relayer && !arret && debut - dernierRelais >= WITHDRAW_RELAYER_INTERVAL_MS) {
      dernierRelais = debut;
      try {
        await relayer.run(() => arret);
      } catch {
        // La passe suivante relit les crédits sur la chaîne : un retrait déjà passé n'est pas refait.
        console.error("[withdraw-relayer] passe échouée, reprise à la suivante");
      }
    }
    // Journal des accès : conservation annoncée de 24 mois (/terms, /privacy). Un lot borné par
    // passe ; un échec ne touche ni la passe des prêts ni son battement, la suivante reprend.
    if (!arret) {
      try {
        const purges = await purgeExpiredAccessLogs(databaseAccessLogRetention, new Date());
        if (purges > 0) console.log(`[reaper] journal des accès purgé : lignes=${purges}`);
      } catch {
        console.error("[reaper] purge du journal des accès échouée, reprise à la suivante");
      }
    }
    // Traces d'accès instantané KYB (wallet, code, IP) : 48 h de conservation, un lot borné par
    // passe ; un échec ne touche ni la passe des prêts ni son battement, la suivante reprend.
    if (!arret) {
      try {
        const purges = await purgeExpiredAutoInvites(databaseAutoInviteRetention, new Date());
        if (purges > 0) console.log(`[reaper] traces d'accès instantané KYB purgées : lignes=${purges}`);
      } catch {
        console.error("[reaper] purge des traces d'accès instantané KYB échouée, reprise à la suivante");
      }
    }
    // Battement lu par check-reaper.sh : seule une « passe ok » prouve que le reaper réconcilie ;
    // un reaper bloqué n'écrit rien, un reaper inopérant écrit « passe échouée ».
    const battement = reaperHeartbeat(bilan, new Date());
    if (battement.ok) console.log(battement.line);
    else console.error(battement.line);
    if (arret) break;
    const reste = interval - (Date.now() - debut);
    if (reste > 0) await pause(reste);
  }

  console.log("[reaper] arrêté proprement");
}

main().catch((error) => {
  console.error(error instanceof AppError
    ? `[reaper] arrêt : ${error.message}`
    : "[reaper] arrêt sur erreur fatale : vérifier la configuration et les contrats");
  process.exitCode = 1;
});
