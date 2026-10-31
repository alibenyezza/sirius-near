/**
 * Traductions des textes et composants partagés (slice A2) : textes d'avertissement
 * communs (`src/lib/copy/disclaimers.ts`), pastille d'état, décomposition du prix et
 * carte de dataset. Fichier séparé pour que les autres slices, qui complètent
 * `english.ts`, ne se marchent pas dessus. Il est fusionné dans `EN_MESSAGES`.
 *
 * Le texte anglais des cinq avertissements est celui de
 * docs/passage-mainnet/16-socle-technique.md, section 4, au mot près.
 */
export const SHARED_MESSAGES_EN: Record<string, string> = {
  // Avertissements communs
  "Sirius entraîne pour l’instant des modèles de base : régression linéaire et régression logistique sur données tabulaires. Les résultats dépendent des données. De nouveaux modèles sont en développement.":
    "Sirius currently trains baseline models: linear and logistic regression on tabular data. Results depend on the data. New models are in development.",
  "Besoin d’un modèle plus puissant ou de données précises ? Contactez-nous à {email}.":
    "Need a stronger model or specific data? Contact us at {email}.",
  "Bêta : vérification on-chain instantanée du wallet, montants plafonnés par prêt et au total.":
    "Beta: instant on-chain wallet verification, capped amounts per loan and in total.",
  "La régression linéaire et la régression logistique sont déterministes : réentraîner sur les mêmes données donne le même modèle.":
    "Linear and logistic regression are deterministic: retraining on the same data gives the same model.",
  "CSV jusqu’à {maxSize}, de {minRows} à {maxRows} lignes, colonnes numériques, jusqu’à {maxFeatures} variables explicatives.":
    "CSV up to {maxSize}, {minRows} to {maxRows} rows, numeric columns, up to {maxFeatures} input features.",

  // Pastille d'état ("En attente" existe déjà dans english.ts)
  "En ligne": "Online",
  "Emprunté": "Borrowed",
  "En pause": "Paused",
  "Expiré": "Expired",
  "Détruit": "Destroyed",
  "Échoué": "Failed",
  "Remboursé": "Refunded",
  "État inconnu": "Unknown status",

  // Décomposition du prix
  "Décomposition du prix": "Price breakdown",
  "Vous recevez": "You receive",
  "Le fournisseur reçoit": "Provider receives",
  "Vous payez": "You pay",
  "Prix payé par l’emprunteur": "Borrower pays",
  "Frais de calcul (enclave Phala)": "Compute fee (Phala enclave)",
  "Minimum imposé par le tarif : {minimum}.": "Minimum set by the tariff: {minimum}.",
  "Sous le minimum imposé par le tarif : {minimum}.": "Below the minimum set by the tariff: {minimum}.",
  "Montant indisponible : valeur invalide.": "Amount unavailable: invalid value.",

  // Carte de dataset ("Profil absent", "{count} lignes" et "{count} colonnes" existent déjà)
  "Emprunts": "Borrows",
  "Revenus totaux": "Total earned",
  "Fournisseur vérifié": "Verified provider",
  "Fournisseur non vérifié": "Unverified provider",
  "Publier un dataset": "Publish a dataset",
  "Dataset sans nom": "Untitled dataset",
};
