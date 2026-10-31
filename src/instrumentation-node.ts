import { isDemoDeployment } from "@/lib/deployment-mode";
import { assertApplicationRunnerConfiguration } from "@/lib/runner/config";
import { exposureLimits } from "@/lib/sirius/exposure-limits";
import { previewGateStartupNotice } from "@/lib/preview-gate/gate";
import { autoInviteStartupNotice } from "@/lib/kyb/auto-invite";
import { fastFinalityPolicy, finalityPolicy } from "@/lib/evm/finality";
import { assistantStartupNotice } from "@/lib/assistant/config";

const DEMO = isDemoDeployment();

export async function registerNode() {
  assertApplicationRunnerConfiguration();
  // Finalité : la politique de base (finalized obligatoire sur mainnet, jamais « confirmations »
  // nu) et les bornes facultatives du palier rapide sont lues au démarrage. Une valeur illisible
  // arrête l'instance ici plutôt qu'au premier prêt ; rien n'est deviné ni dégradé.
  finalityPolicy();
  const fastFinality = fastFinalityPolicy();
  if (fastFinality.enabled) {
    console.log(`[sirius] finalité rapide active : prêts ≤ ${process.env.SIRIUS_FAST_FINALITY_MAX_USDC?.trim() || "25"} (plafond en cours ${process.env.SIRIUS_FAST_FINALITY_TOTAL_USDC?.trim() || "100"}), ${fastFinality.confirmations} confirmations`);
  }
  // Porte d'aperçu du passage mainnet : dire au démarrage ce qu'elle ferme, sans jamais
  // écrire la clé (le message ne contient que des noms de variables).
  const previewGate = previewGateStartupNotice();
  if (previewGate) console.warn(previewGate);
  // Accès instantané KYB : refuse de démarrer si le drapeau est posé sans clé valide, ou
  // avec la clé du vérificateur de démonstration. Drapeau absent = fermé, sans rien casser.
  // Le message ne contient que l'adresse publique du vérificateur automatique, jamais la clé.
  const autoInvite = autoInviteStartupNotice();
  if (autoInvite) console.warn(autoInvite);
  // Assistant Sirio : même logique, drapeau absent = chat fermé sans rien exiger ; « true »
  // sans ANTHROPIC_API_KEY refuse de démarrer. La clé n'apparaît jamais dans le message.
  const assistant = assistantStartupNotice();
  if (assistant) console.warn(assistant);
  if (process.env.NODE_ENV === "production") {
    if (process.env.NEXT_PUBLIC_SIRIUS_E2E === "1") {
      throw new Error("NEXT_PUBLIC_SIRIUS_E2E interdit en production");
    }

    // Verrou principal. Les assouplissements du mode démonstration ne doivent jamais
    // s'appliquer à de l'argent réel : sur mainnet, l'instance repasse par la porte
    // stricte ou ne démarre pas du tout.
    if (DEMO && (process.env.EVM_NETWORK === "mainnet" || process.env.NEXT_PUBLIC_EVM_NETWORK === "mainnet")) {
      throw new Error("SIRIUS_DEPLOYMENT_MODE=demo est interdit sur mainnet");
    }

    if (!DEMO) {
      if (process.env.TEE_MODE !== "phala") throw new Error("TEE_MODE=phala obligatoire en production");
      if (process.env.DSTACK_SIMULATOR_ENDPOINT) throw new Error("Simulateur dstack interdit en production");
    }

    // Ce que toute instance servie publiquement exige, démonstration comprise :
    // de quoi signer les sessions, se désigner elle-même, et pointer sans ambiguïté
    // sur des contrats déployés.
    const requises = [
      "SIRIUS_SESSION_SECRET",
      "SIRIUS_APP_ORIGIN",
      "NEXT_PUBLIC_SIRIUS_APP_ORIGIN",
      "SIRIUS_ESCROW_ADDRESS",
      "SIRIUS_USDC_ADDRESS",
      "SIRIUS_KYB_ADDRESS",
      "SIRIUS_DATASET_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS",
    ];

    // Ce qu'une instance de démonstration doit fournir pour tenir sa promesse : la
    // maison paie le gas du visiteur, sur les deux postes et depuis deux comptes
    // distincts. Les exiger ici transforme une panne silencieuse en refus de démarrer —
    // sans la clé du faucet, « Ajouter des fonds » se rabattrait sur MoonPay, qui n'a
    // rien à vendre sur un testnet, et le visiteur lirait « indisponible » sans que
    // personne ne sache pourquoi.
    if (DEMO) {
      requises.push("SIRIUS_FAUCET_KEY", "SIRIUS_KYB_VERIFIER_KEY");
    }

    // Ce que seule une instance adossée à une enclave réelle peut fournir. En
    // démonstration ces valeurs n'existent pas encore — les exiger reviendrait à
    // interdire la démonstration.
    if (!DEMO) {
      requises.push(
        "RUNNER_URL",
        "RUNNER_TRANSPORT_SECRET",
        "SIRIUS_EXPECTED_MRTD",
        "SIRIUS_EXPECTED_COMPOSE_HASH",
        "SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256",
        "NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256",
        // Bêta mainnet sans audit externe : l'application borne seule l'argent exposé.
        "SIRIUS_MAX_LOAN_USDC",
        "SIRIUS_MAX_EXPOSURE_USDC",
      );
    }

    for (const name of requises) {
      if (!process.env[name]) throw new Error(`${name} obligatoire en production`);
    }

    // Le devnet de Web3Auth fait tourner ses clés : un compte créé dessus finit inaccessible,
    // avec ses datasets. Acceptable sur une recette hébergée en *.vercel.app, pas sur le
    // domaine public — et une valeur absente ou mal orthographiée retombe justement sur le
    // devnet, sans erreur. D'où un refus explicite plutôt qu'un défaut silencieux.
    if (
      process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID?.trim() &&
      process.env.NEXT_PUBLIC_WEB3AUTH_NETWORK?.trim() !== "sapphire_mainnet" &&
      !/^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/i.test(process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN?.trim() ?? "")
    ) {
      throw new Error("NEXT_PUBLIC_WEB3AUTH_NETWORK=sapphire_mainnet obligatoire hors staging");
    }

    if (
      process.env.SIRIUS_APP_ORIGIN?.trim().replace(/\/+$/, "") !==
      process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN?.trim().replace(/\/+$/, "")
    ) {
      throw new Error("Les origines publique et serveur de Sirius doivent être identiques");
    }

    // Le reaper tourne désormais comme worker autonome, hors du processus web. En
    // démonstration sur un hébergeur serverless, aucun processus ne lui survivrait
    // de toute façon.
    if (!DEMO && process.env.SIRIUS_REAPER_ENABLED !== "true") {
      throw new Error("SIRIUS_REAPER_ENABLED=true obligatoire en production");
    }
    if (process.env.SIRIUS_TRUST_PROXY_HEADERS !== "true") {
      throw new Error("SIRIUS_TRUST_PROXY_HEADERS=true obligatoire en production");
    }
    if (process.env.SIRIUS_INGRESS_RATE_LIMITED !== "true") {
      throw new Error("SIRIUS_INGRESS_RATE_LIMITED=true obligatoire en production");
    }

    if (!DEMO && (process.env.EVM_NETWORK !== "mainnet" || process.env.NEXT_PUBLIC_EVM_NETWORK !== "mainnet")) {
      throw new Error("EVM_NETWORK et NEXT_PUBLIC_EVM_NETWORK doivent être mainnet en production");
    }
    if (DEMO && (process.env.EVM_NETWORK !== "testnet" || process.env.NEXT_PUBLIC_EVM_NETWORK !== "testnet")) {
      throw new Error("Le mode démonstration exige EVM_NETWORK et NEXT_PUBLIC_EVM_NETWORK sur testnet");
    }

    // Contrôle conservé dans les deux modes : une valeur serveur et sa jumelle
    // publique qui divergent produiraient une interface affichant un contrat pendant
    // que le serveur en interroge un autre.
    for (const [privateName, publicName] of [
      ["SIRIUS_ESCROW_ADDRESS", "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS"],
      ["SIRIUS_USDC_ADDRESS", "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS"],
      ["SIRIUS_KYB_ADDRESS", "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS"],
      ["SIRIUS_DATASET_ADDRESS", "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS"],
    ]) {
      if (process.env[privateName]?.toLowerCase() !== process.env[publicName]?.toLowerCase()) {
        throw new Error(`${privateName} et ${publicName} doivent désigner le même contrat`);
      }
    }
    // Valeurs lisibles et cohérentes (par prêt ≤ exposition), refusées au démarrage plutôt qu’au premier emprunt.
    exposureLimits();
  }

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.TEE_MODE === "phala" &&
    !process.env.RUNNER_URL
  ) {
    const { initEnclave } = await import("@/lib/tee/dstack");
    await initEnclave();
  }

  if (process.env.SIRIUS_REAPER_ENABLED === "true") {
    const { startLoanReaper } = await import("@/lib/sirius/reaper");
    startLoanReaper();
  }

  // Annonce le compte de règlement, comme le runner autonome le fait à son démarrage.
  //
  // Escrow v6 grave dans son constructeur l'unique adresse autorisée à signer un lock, et
  // cette adresse est dérivée de la master key. Quand le runner tourne dans ce processus,
  // c'est donc ici — et nulle part ailleurs — qu'on peut la lire sans sortir la clé de
  // l'environnement. Une instance qui délègue à un runner distant ne la connaît pas :
  // le sien vient de sa propre clé, et l'afficher d'ici induirait en erreur.
  if (!process.env.RUNNER_URL) {
    try {
      const { runnerSettlementAddress } = await import("@/lib/evm/escrow");
      console.log(`[sirius] compte de règlement EVM (runner in-process) : ${runnerSettlementAddress()}`);
    } catch {
      // Pas de master key exploitable dans ce processus : rien à annoncer.
    }
  }
}
