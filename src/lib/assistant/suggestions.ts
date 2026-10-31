/**
 * Questions proposées dans l'état vide du panneau Sirio, selon la page affichée. Celles qui
 * ont une `answer` sont aussi servies hors ligne quand le chat est coupé sur l'instance ; les
 * autres (données en direct, lues par les outils du modèle) n'apparaissent que si le chat
 * répond. Clés françaises, traduites à l'affichage ; `assistant-en.ts` porte les valeurs.
 * Les réponses hors ligne ne contiennent aucun chiffre qui pourrait changer : elles renvoient
 * vers la page qui fait foi.
 */
export interface AssistantSuggestion {
  question: string;
  answer?: string;
}

const BORROW: AssistantSuggestion = {
  question: "Comment emprunter un dataset ?",
  answer: "Ouvre la Marketplace, choisis un dataset et clique sur Emprunter : le prix et le compute sont bloqués en escrow, puis l’entraînement tourne dans un TEE.",
};
const FINALITY: AssistantSuggestion = {
  question: "Pourquoi attendre ~15 minutes ?",
  answer: "Après le paiement, la chaîne doit atteindre la finalité (~15 min) avant que le job puisse démarrer. Laisse la page Entraîner ouverte ou reviens cliquer sur Lancer le job.",
};
const PUBLISH: AssistantSuggestion = {
  question: "Comment publier des données ?",
  answer: "Dans Mes datasets, importe un CSV : il est chiffré dans ton navigateur, puis publie son titre on-chain pour le rendre empruntable.",
};
const SAFETY: AssistantSuggestion = {
  question: "Mes données sont-elles en sécurité ?",
  answer: "Les données brutes ne quittent jamais le chiffrement : l’entraînement tourne dans une enclave et l’emprunteur ne reçoit que le modèle.",
};
const LIVE_COUNT: AssistantSuggestion = { question: "Combien de datasets sur la marketplace ?" };
const LIVE_STATUS: AssistantSuggestion = { question: "Quels sont les plafonds de prêt ?" };

/** Suggestions par préfixe de chemin ; la première entrée qui correspond l'emporte. */
const BY_PAGE: readonly { prefix: string; suggestions: readonly AssistantSuggestion[] }[] = [
  {
    prefix: "/marketplace",
    suggestions: [
      LIVE_COUNT,
      BORROW,
      { question: "Que veut dire le badge « vérifié » ?", answer: "Le badge indique que le fournisseur du dataset a une attestation KYB valide dans le registre on-chain. Sans attestation valide, le dataset reste visible mais ne peut pas être emprunté." },
      SAFETY,
    ],
  },
  {
    prefix: "/train",
    suggestions: [
      FINALITY,
      { question: "Comment récupérer mon modèle ?", answer: "Quand l’entraînement est réglé, clique sur Vérifier et télécharger sur la page Entraîner : la clé du modèle est livrée et tu peux le déchiffrer dans ton navigateur." },
      { question: "Que faire si l’entraînement échoue ?", answer: "Le prix du dataset et le compute non utilisé sont remboursés dans l’escrow ; seuls les frais d’exécution mesurés, plafonnés dans le devis, sont retenus. Retire le crédit depuis la page Wallet." },
      BORROW,
    ],
  },
  {
    prefix: "/datasets",
    suggestions: [
      PUBLISH,
      { question: "Quelles limites pour mon CSV ?", answer: "Un CSV de colonnes numériques, assez grand pour préserver la confidentialité : la taille, le nombre de lignes et de colonnes acceptés sont rappelés sur la page de publication." },
      { question: "Quand suis-je payé·e ?", answer: "À chaque entraînement réglé, ton gain est crédité dans l’escrow : retire-le depuis la page Wallet (tu paies le gas)." },
      SAFETY,
    ],
  },
  {
    prefix: "/wallet",
    suggestions: [
      { question: "Comment ajouter des fonds ?", answer: "Clique sur Ajouter des fonds : par carte, depuis un autre wallet ou depuis une autre chaîne sur mainnet ; un robinet de test sur le testnet." },
      { question: "Pourquoi me faut-il de l’ETH ?", answer: "Le gas (frais réseau) se paie toujours en ETH sur Robinhood Chain, séparément du stablecoin qui règle les emprunts." },
      { question: "Comment retirer mes règlements ?", answer: "Les règlements et remboursements sont crédités dans l’escrow : sur la page Wallet, clique sur Retirer pour les ramener dans ton wallet." },
    ],
  },
  {
    prefix: "/explorer",
    suggestions: [
      { question: "Que montre l’Explorer ?", answer: "Tes emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne. Jamais le contenu des datasets." },
      { question: "Qu’est-ce qu’un reçu d’audit ?", answer: "Chaque entraînement produit un reçu d’audit et un certificat qui lient le titre du dataset, le prêt, l’attestation TEE et l’empreinte du modèle livré." },
      SAFETY,
    ],
  },
  {
    prefix: "/kyb",
    suggestions: [
      { question: "Pourquoi vérifier mon wallet ?", answer: "Chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde sur la marketplace." },
      { question: "Comment obtenir l’accès instantané ?", answer: "Quand il est ouvert, Sirius signe une attestation de 30 jours pour ton wallet : une seule transaction à confirmer, avec un peu d’ETH pour le gas." },
      SAFETY,
    ],
  },
  {
    prefix: "/phala",
    suggestions: [
      SAFETY,
      { question: "Qu’est-ce qu’une attestation TEE ?", answer: "La preuve, vérifiée à chaque requête, que le code qui entraîne tourne bien dans l’enclave attendue : son identité est épinglée et comparée." },
      BORROW,
    ],
  },
  { prefix: "/dashboard", suggestions: [BORROW, PUBLISH, LIVE_COUNT, LIVE_STATUS] },
];

const DEFAULT: readonly AssistantSuggestion[] = [BORROW, PUBLISH, LIVE_COUNT, SAFETY];

/** Suggestions de la page affichée (`/marketplace/abc` hérite de `/marketplace`). */
export function assistantSuggestionsFor(pathname: string | null): readonly AssistantSuggestion[] {
  const match = pathname ? BY_PAGE.find((entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`)) : null;
  return match ? match.suggestions : DEFAULT;
}

/** Réponse hors ligne d'une question proposée, reconnue par sa clé ou sa traduction. */
export function assistantCannedAnswer(pathname: string | null, content: string, translate: (key: string) => string): string | null {
  const hit = assistantSuggestionsFor(pathname).find((item) => item.answer && (item.question === content || translate(item.question) === content));
  return hit?.answer ?? null;
}

/** Toutes les clés (questions et réponses), pour le test de traduction. */
export function assistantSuggestionKeys(): string[] {
  const keys = new Set<string>();
  for (const entry of [...BY_PAGE.map((page) => page.suggestions), DEFAULT]) {
    for (const item of entry) {
      keys.add(item.question);
      if (item.answer) keys.add(item.answer);
    }
  }
  return [...keys];
}
