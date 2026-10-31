import type { EvmNetwork } from "@/lib/evm/networks";

/**
 * Visites de page du guide Sirio : à la première ouverture de chaque page de l'application
 * (après le parcours d'accueil, terminé ou passé), le personnage met en lumière les éléments
 * clés de LA PAGE AFFICHÉE, un ou deux phrases chacun — pourquoi, comment —, puis se range
 * dans sa bulle. Chaque arrêt vise une ancre `data-guide="page:<page>:<élément>"` posée sur le
 * vrai composant ; un arrêt dont l'ancre n'est pas à l'écran (liste vide, wallet non connecté,
 * état absent) est sauté, le premier arrêt (sans ancre) présente la page.
 *
 * Module pur, sans React : clés françaises traduites à l'affichage (`guide-en.ts`), `{token}`
 * pour le jeton de règlement, variantes mainnet / testnet quand la phrase en dépend. Les chiffres
 * (durées, limites) ne sont jamais recopiés ici : la page qui fait foi les affiche.
 */

export const GUIDE_PAGE_KEYS = ["dashboard", "train", "phala", "marketplace", "dataset", "datasets", "upload", "explorer", "wallet", "kyb"] as const;
export type GuidePageKey = (typeof GUIDE_PAGE_KEYS)[number];

export function isGuidePageKey(value: unknown): value is GuidePageKey {
  return typeof value === "string" && (GUIDE_PAGE_KEYS as readonly string[]).includes(value);
}

const EXACT_PATHS: Readonly<Record<string, GuidePageKey>> = {
  "/dashboard": "dashboard",
  "/train": "train",
  "/phala": "phala",
  "/marketplace": "marketplace",
  "/datasets": "datasets",
  "/datasets/new": "upload",
  "/explorer": "explorer",
  "/wallet": "wallet",
  "/kyb": "kyb",
};

/**
 * Page visitée pour un chemin : correspondance exacte, plus la fiche `/marketplace/<id>`. Une
 * fiche `/datasets/<id>` n'a pas de visite (sa liste la décrit déjà).
 */
export function guidePageForPath(pathname: string | null | undefined): GuidePageKey | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 256) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (Object.hasOwn(EXACT_PATHS, path)) return EXACT_PATHS[path];
  if (/^\/marketplace\/[^/]+$/.test(path)) return "dataset";
  return null;
}

export interface GuidePageStep {
  /** Élément visé (`data-guide="page:<page>:<anchor>"`), ou `null` : présentation de la page, sans lumière. */
  anchor: string | null;
  title: string;
  /** Une phrase ou deux ; une variante par réseau quand le mot « mainnet » ou l'offre de dépôt en dépend. */
  body: string | Readonly<Record<EvmNetwork, string>>;
}

export interface GuidePageTour {
  title: string;
  steps: readonly GuidePageStep[];
}

export const GUIDE_PAGE_TOURS: Readonly<Record<GuidePageKey, GuidePageTour>> = {
  dashboard: {
    title: "Tableau de bord",
    steps: [
      { anchor: null, title: "Ton tableau de bord", body: "Tout ce qui compte pour ton compte en un coup d’œil : ta liste de départ, ton solde et tes raccourcis." },
      { anchor: "get-started", title: "Bien démarrer", body: "Cette liste suit l’état réel de ton compte — connexion, vérification, fonds — et disparaît quand tout est fait." },
      { anchor: "balance", title: "Ton solde", body: "Ton solde en {token}, et l’ETH qu’il te reste pour le gas. « Ajouter des fonds » ouvre les options de dépôt." },
      { anchor: "credits", title: "À retirer", body: "Les règlements et remboursements arrivent d’abord ici, dans l’escrow : retire-les pour les ramener dans ton wallet." },
      { anchor: "trust", title: "Confiance EVM", body: "Tes emprunts réglés, remboursés et tes preuves on-chain, côté fournisseur et côté emprunteur." },
      { anchor: "shortcuts", title: "Raccourcis", body: "Marketplace pour emprunter, Entraîner pour suivre tes jobs, Mes datasets pour publier les tiens." },
    ],
  },
  train: {
    title: "Entraîner",
    steps: [
      { anchor: null, title: "Entraîner un modèle", body: "Ici tu suis tes emprunts et tes entraînements : chaque carte est un prêt, du paiement jusqu’au modèle livré." },
      { anchor: "own-data", title: "Tes propres données", body: "Entraîner sur tes données sans escrow est réservé à l’équipe pendant la bêta : écris-nous pour l’essayer." },
      { anchor: "history", title: "Mes entraînements", body: "Après un emprunt, attends la finalité du paiement (~15 min), puis « Lancer le job (TEE) ». Un modèle réglé se vérifie et se télécharge ici ; un prêt jamais réglé se rembourse après son délai." },
    ],
  },
  phala: {
    title: "Phala",
    steps: [
      { anchor: null, title: "Phala, l’enclave", body: "Le calcul tourne dans une enclave Phala (Intel TDX) : l’identité du code est attestée à chaque requête, et personne ne voit tes données." },
      { anchor: "attestation", title: "L’attestation", body: "Ce lien ouvre l’attestation du runner : la preuve que le code attendu tourne bien dans l’enclave." },
      { anchor: "examples", title: "Jeux d’exemple", body: "Un dataset synthétique prêt à l’emploi pour essayer sans rien préparer." },
      { anchor: "prepare", title: "Préparer l’entraînement", body: "Ton CSV, le modèle et la colonne à prédire. Le fichier est chiffré dans ton navigateur ; le calcul est offert pendant la démo." },
      { anchor: "results", title: "Mes résultats", body: "Tes modèles entraînés restent dans ce navigateur : télécharge-les pour les garder ailleurs." },
      { anchor: "workspace", title: "L’espace Phala", body: "La démo s’ouvre dans un espace dédié ; l’entraînement standard reste sur la page Entraîner." },
    ],
  },
  marketplace: {
    title: "Marketplace",
    steps: [
      { anchor: null, title: "La marketplace", body: "Les datasets publiés par les fournisseurs. Un emprunt, c’est un entraînement dans l’enclave : tu reçois le modèle, jamais la donnée." },
      { anchor: "search", title: "Rechercher", body: "Par nom ou description ; la recherche part après une pause de frappe, ou sur Entrée." },
      { anchor: "filters", title: "Filtrer", body: "Catégorie, modèle, prix total, taille — et « Vérifiés uniquement » pour ne garder que les fournisseurs attestés." },
      { anchor: "sort", title: "Trier", body: "Plus récents, plus empruntés ou prix croissant." },
      { anchor: "grid", title: "Les fiches", body: "Prix affiché frais de calcul compris quand ils sont connus, lignes, colonnes, badge « vérifié ». L’étoile garde un favori ; clique sur une fiche pour l’ouvrir et emprunter." },
    ],
  },
  dataset: {
    title: "Fiche d’un dataset",
    steps: [
      { anchor: null, title: "Fiche d’un dataset", body: "Tout ce qui est public sur ce dataset avant d’emprunter. Les colonnes elles-mêmes restent chiffrées." },
      { anchor: "data", title: "Les données", body: "Lignes, colonnes, taille et catégorie. Les noms et types des colonnes ne sont pas publiés." },
      { anchor: "model", title: "Le modèle", body: "Fixé par le fournisseur à la publication : c’est ce modèle entraîné que tu recevras, avec ses coefficients et ses métriques." },
      { anchor: "stats", title: "Statistiques", body: "Emprunts passés et part réglée au fournisseur : un signal sur la fiabilité du dataset." },
      { anchor: "price", title: "Ce que tu paies", body: "La part du fournisseur plus les frais de calcul. Le montant exact est dans le devis, avant tout paiement ; le gas se paie à part, en ETH." },
      { anchor: "borrow", title: "Emprunter", body: "Une transaction bloque le prix en escrow. La connexion et la vérification du wallet ne sont demandées qu’à ce moment-là." },
    ],
  },
  datasets: {
    title: "Mes datasets",
    steps: [
      { anchor: null, title: "Mes datasets", body: "Les datasets importés depuis ce wallet : leur état, leurs emprunts et ce qu’ils t’ont rapporté." },
      { anchor: "sort", title: "Trier", body: "Par date, par revenus ou par emprunts." },
      { anchor: "new", title: "Publier un dataset", body: "La tuile ouvre l’import : CSV chiffré dans ton navigateur, puis prix et durée de publication." },
      { anchor: "cards", title: "Tes fiches", body: "La pastille dit l’état — brouillon, en ligne, emprunté, en pause — et un brouillon se publie depuis son bouton." },
    ],
  },
  upload: {
    title: "Publier un dataset",
    steps: [
      { anchor: null, title: "Publier un dataset", body: "Deux étapes : la donnée, puis le prix et la publication. Rien ne quitte ton navigateur en clair." },
      { anchor: "steps", title: "Les étapes", body: "La donnée d’abord — fichier, nom, catégorie, profil —, puis le prix et la durée de publication." },
      { anchor: "file", title: "Ton CSV", body: "Glisse ton fichier ou charge le jeu d’exemple. Il reste sur ton appareil tant que tu ne publies pas." },
      { anchor: "profile", title: "Catégorie et profil", body: "La catégorie sert de filtre sur la marketplace ; le profil d’entraînement est vérifié sur le CSV puis verrouillé on-chain." },
      { anchor: "price", title: "Ton gain", body: "Ce que tu veux gagner par emprunt, en {token}. Les frais de calcul s’ajoutent pour l’emprunteur." },
      { anchor: "duration", title: "Durée de publication", body: "Le temps pendant lequel le dataset reste empruntable ; tu pourras le mettre en pause avant." },
      { anchor: "publish", title: "Publier", body: "Chiffrement, scellement dans l’enclave, IPFS, puis le titre on-chain : une transaction à signer dans ton wallet." },
    ],
  },
  explorer: {
    title: "Explorer",
    steps: [
      { anchor: null, title: "Explorer", body: "Tes emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne. Jamais le contenu des datasets." },
      { anchor: "summary", title: "En chiffres", body: "Emprunts, datasets empruntés, réglés, remboursés : le résumé de ton activité on-chain." },
      { anchor: "loan", title: "Un emprunt", body: "Titre du dataset, lock, attestation TEE, reçu d’audit, règlement ou remboursement : chaque preuve a son lien « Vérifier »." },
    ],
  },
  wallet: {
    title: "Wallet",
    steps: [
      { anchor: null, title: "Ton wallet", body: "Solde, gas, dépôt, retrait : tout ce qui touche à l’argent passe ici — et reste dans ton wallet ou dans l’escrow, jamais chez Sirius." },
      {
        anchor: "balance",
        title: "Solde et gas",
        body: {
          mainnet: "Ton solde en {token} et l’ETH pour le gas. « Ajouter des fonds » : par carte, depuis un autre wallet ou depuis une autre chaîne.",
          testnet: "Ton solde en {token} et l’ETH pour le gas. « Ajouter des fonds » envoie des jetons de test et un peu d’ETH de test.",
        },
      },
      { anchor: "account", title: "Ton compte", body: "Le réseau du site, ton adresse à copier, et l’état de ta session signée." },
      { anchor: "credits", title: "À retirer", body: "Les règlements et remboursements arrivent d’abord dans l’escrow : « Retirer » les ramène dans ton wallet, contre un peu de gas." },
    ],
  },
  kyb: {
    title: "Vérification du wallet",
    steps: [
      {
        anchor: null,
        title: "Vérification du wallet",
        body: {
          mainnet: "Sur mainnet, chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde.",
          testnet: "Chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde.",
        },
      },
      { anchor: "status", title: "Ton statut", body: "Lu dans le registre de vérification on-chain : vérifié, avec la date d’expiration, ou non vérifié." },
      { anchor: "invite", title: "Obtenir l’accès", body: "L’accès instantané quand il est ouvert — une transaction —, sinon le code d’invitation reçu de l’équipe." },
      { anchor: "soon", title: "Bientôt", body: "Ce qui arrive ensuite pour la vérification." },
    ],
  },
};

export const GUIDE_PAGE_UI = {
  skip: "Passer la visite",
  replay: "Revoir la visite de cette page",
  help: "Visite de cette page",
  progress: "Progression de la visite",
} as const;

/** Attribut posé sur l'élément visé par un arrêt. */
export function guidePageAnchor(page: GuidePageKey, anchor: string): `page:${GuidePageKey}:${string}` {
  return `page:${page}:${anchor}`;
}

/** Texte d'un arrêt pour le réseau du site. */
export function guidePageStepBody(step: GuidePageStep, network: EvmNetwork): string {
  return typeof step.body === "string" ? step.body : step.body[network];
}

/** Arrêts affichables : ceux dont l'ancre est à l'écran, et la présentation sans ancre. */
export function visibleGuidePageSteps(page: GuidePageKey, present: ReadonlySet<string>): GuidePageStep[] {
  return GUIDE_PAGE_TOURS[page].steps.filter((step) => step.anchor === null || present.has(step.anchor));
}

/** Clé stable d'un arrêt : son ancre, ou `null` pour la présentation de la page. */
export type GuidePageStepKey = string | null;

/**
 * Arrêt courant d'une visite, retrouvé par sa clé (ancre) parmi les arrêts visibles — jamais par
 * un indice dans la liste filtrée, qui glisserait si une ancre apparaît ou disparaît en cours de
 * visite. Si l'ancre courante n'est plus visible, l'arrêt visible suivant dans l'ordre de la
 * visite prend la place (à défaut, le dernier visible).
 */
export function resolveGuidePageStep(
  page: GuidePageKey,
  present: ReadonlySet<string>,
  key: GuidePageStepKey,
): { steps: GuidePageStep[]; index: number } {
  const steps = visibleGuidePageSteps(page, present);
  const exact = steps.findIndex((step) => step.anchor === key);
  if (exact !== -1) return { steps, index: exact };
  const all = GUIDE_PAGE_TOURS[page].steps;
  const position = all.findIndex((step) => step.anchor === key);
  if (position !== -1) {
    for (const step of all.slice(position + 1)) {
      const index = steps.indexOf(step);
      if (index !== -1) return { steps, index };
    }
  }
  return { steps, index: Math.max(0, steps.length - 1) };
}

/** Toutes les clés de traduction des visites de page, pour le test. */
export function guidePageCopyKeys(): string[] {
  const keys = new Set<string>(Object.values(GUIDE_PAGE_UI));
  for (const tour of Object.values(GUIDE_PAGE_TOURS)) {
    keys.add(tour.title);
    for (const step of tour.steps) {
      keys.add(step.title);
      if (typeof step.body === "string") keys.add(step.body);
      else for (const body of Object.values(step.body)) keys.add(body);
    }
  }
  return [...keys];
}
