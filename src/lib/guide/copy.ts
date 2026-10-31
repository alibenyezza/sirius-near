import type { EvmNetwork } from "@/lib/evm/networks";
import { GUIDE_NAME, GUIDE_TOUR_STOPS, type GuideTourStopKey, type GuideVerifyMode } from "./machine";

/**
 * Textes du guide Sirio, hors des composants pour que le test de traduction vérifie chaque clé.
 * Clés françaises, valeurs anglaises dans `src/lib/i18n/guide-en.ts`. `{name}` est le nom du
 * personnage, `{token}` le jeton de règlement du réseau ; les phrases qui parlent du mainnet ont
 * une variante sans ce mot pour le testnet.
 */

export const GUIDE_UI = {
  skip: "Passer le guide",
  next: "Suivant",
  previous: "Précédent",
  start: "C’est parti",
  finish: "Terminer",
  minimize: "Réduire le guide",
  open: "Ouvrir {name}",
  replay: "Revoir la visite guidée",
  chat: "Poser une question",
  spotlight: "Élément mis en avant par le guide",
  stepOf: "Étape {current} / {total}",
  waiting: "J’attends que ce soit fait…",
  bubbleLabel: "{name}, le guide Sirius",
} as const;

/** Accueil : qui est le personnage, et Sirius en deux phrases. */
export const GUIDE_ARRIVAL = {
  title: "Salut, je suis {name}.",
  body: [
    "Sirius permet d’entraîner un modèle sur des données confidentielles sans jamais les voir, et d’être payé quand on prête les siennes.",
    "Je te montre comment ça marche en quelques étapes — tu peux passer à tout moment.",
  ],
} as const;

export const GUIDE_CONNECT = {
  title: "Connecte un wallet",
  body: "Ton wallet est ton compte Sirius : pas d’e-mail ni de mot de passe. Clique sur Connexion, puis choisis ton wallet.",
  done: "Wallet connecté. Maintenant, prouvons qu’il est bien à toi.",
} as const;

export const GUIDE_SIGNIN = {
  title: "Signe pour te connecter",
  body: "Clique sur Se connecter : ton wallet te demande de signer un message. C’est gratuit, ce n’est pas une transaction, et ça prouve que ce wallet est bien à toi.",
  done: "Bravo, tu es connecté·e !",
} as const;

const VERIFY_WHY: Record<EvmNetwork, string> = {
  mainnet: "Sur mainnet, chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde.",
  testnet: "Chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde.",
};

export const GUIDE_VERIFY = {
  title: "Vérifie ton wallet",
  mode: {
    loading: "Je regarde si ton wallet est déjà vérifié…",
    instant: "Une seule transaction à confirmer dans ton wallet, et c’est fait.",
    "needs-gas": "Il te faut un peu d’ETH pour payer le gas de cette transaction : ajoute des fonds d’abord, je t’attends ici.",
    invitation: "L’accès instantané n’est pas ouvert : colle le code d’invitation reçu de l’équipe, ou écris-nous.",
    unknown: "Je n’arrive pas à lire ton statut pour l’instant. Tu peux le vérifier sur la page Vérification, ou continuer.",
  } satisfies Record<GuideVerifyMode, string>,
  action: {
    instant: "Obtenir l’accès instantané",
    "needs-gas": "Ajouter des fonds",
    invitation: "Saisir un code d’invitation",
    unknown: "Voir mon statut de vérification",
  },
  done: "Ton wallet est vérifié. Je te fais visiter ?",
} as const;

export function guideVerifyWhy(network: EvmNetwork): string {
  return VERIFY_WHY[network];
}

/** Une phrase par page du menu. `{token}` : jeton de règlement. */
export const GUIDE_TOUR_COPY: Record<GuideTourStopKey, { title: string; body: string }> = {
  marketplace: { title: "Marketplace", body: "Parcours les datasets publiés, et emprunte celui qu’il te faut : le prix est bloqué en escrow, jamais versé d’avance." },
  train: { title: "Entraîner", body: "Lance tes entraînements et récupère tes modèles ici. Après le paiement, compte ~15 minutes de finalité avant de lancer le job." },
  datasets: { title: "Mes datasets", body: "Dépose un CSV : il est chiffré dans ton navigateur, et tu es payé·e en {token} à chaque entraînement réglé." },
  explorer: { title: "Explorer", body: "Tes emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne." },
  phala: { title: "Phala", body: "L’enclave qui entraîne sans voir les données : son identité est attestée à chaque requête." },
  dashboard: { title: "Tableau de bord", body: "Ton solde, ta liste « Bien démarrer » et tes raccourcis. On y revient quand tu veux." },
};

export const GUIDE_TOUR_END = {
  title: "Tu sais tout !",
  body: "Je reste dans ma bulle en bas à droite : clique dessus pour me poser une question ou revoir la visite.",
} as const;

/** Toutes les clés ci-dessus, pour le test de traduction. */
export function guideCopyKeys(): string[] {
  return [
    ...Object.values(GUIDE_UI),
    GUIDE_ARRIVAL.title, ...GUIDE_ARRIVAL.body,
    GUIDE_CONNECT.title, GUIDE_CONNECT.body, GUIDE_CONNECT.done,
    GUIDE_SIGNIN.title, GUIDE_SIGNIN.body, GUIDE_SIGNIN.done,
    GUIDE_VERIFY.title, ...Object.values(GUIDE_VERIFY.mode), ...Object.values(GUIDE_VERIFY.action), GUIDE_VERIFY.done,
    ...Object.values(VERIFY_WHY),
    ...GUIDE_TOUR_STOPS.flatMap((stop) => [GUIDE_TOUR_COPY[stop.key].title, GUIDE_TOUR_COPY[stop.key].body]),
    GUIDE_TOUR_END.title, GUIDE_TOUR_END.body,
  ];
}

export { GUIDE_NAME };
