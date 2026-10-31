/**
 * Traductions de la marketplace publique (slice N3) : grille, filtres, fiche et messages de la
 * route `GET /api/marketplace`. Fichier séparé, comme `shared-en.ts`, pour ne pas entrer en
 * conflit avec les autres slices qui complètent `english.ts` ; il est fusionné dans `EN_MESSAGES`.
 */
export const MARKETPLACE_MESSAGES_EN: Record<string, string> = {
  // Catégories (liste fixe de l'upload, src/lib/marketplace/categories.ts)
  "Finance": "Finance",
  "Santé": "Health",
  "Commerce": "Commerce",
  "Industrie": "Industry",
  "Mobilité": "Mobility",
  "Énergie": "Energy",
  "Marketing": "Marketing",
  "Autre": "Other",

  // Grille et filtres
  "Datasets disponibles": "Available datasets",
  "Un emprunt = l’accès à un dataset et un entraînement dans l’enclave. Vous recevez le modèle entraîné, jamais la donnée.":
    "One loan = access to a dataset and one training run inside the enclave. You receive the trained model, never the data.",
  "Consultation libre, sans wallet. La connexion n’est demandée qu’au moment d’emprunter.":
    "Browse freely, no wallet needed. You are only asked to connect when you borrow.",
  "Rechercher un dataset": "Search datasets",
  "Rechercher par nom ou description": "Search by name or description",
  "Filtres": "Filters",
  "Catégorie": "Category",
  "Toutes": "All",
  "Tous": "All",
  "Prix total": "Total price",
  "Prix total ({symbol})": "Total price ({symbol})",
  "Taille (lignes)": "Size (rows)",
  "Minimum": "Minimum",
  "Maximum": "Maximum",
  "Min": "Min",
  "Max": "Max",
  "Appliquer": "Apply",
  "Fournisseur": "Provider",
  "Vérifiés uniquement": "Verified providers only",
  "Réinitialiser les filtres": "Reset filters",
  "{count} datasets": "{count} datasets",
  "Trier par": "Sort by",
  "Plus récents": "Most recent",
  "Plus empruntés": "Most borrowed",
  "Prix croissant": "Price: low to high",
  "Les prix incluent les frais de calcul indicatifs de chaque modèle (dernier devis ou tarif publié). Le montant exact est affiché dans le devis, avant tout paiement.":
    "Prices include each model's indicative compute fee (latest quote or published rate). The exact amount is shown in the quote, before any payment.",
  "Quand les frais de calcul ne sont pas encore connus, la carte indique ce que reçoit le fournisseur ; les frais s’ajoutent dans le devis.":
    "When the compute fee is not known yet, the card shows what the provider receives; the fee is added in the quote.",
  "Le statut de vérification de certains fournisseurs n’a pas pu être lu. Ils sont affichés sans badge et exclus du filtre « vérifiés ».":
    "The verification status of some providers could not be read. They are shown without a badge and excluded from the “verified” filter.",
  "Seuls les {count} datasets les plus récents ont été parcourus.": "Only the {count} most recent datasets were searched.",
  "Aucun dataset ne correspond à ces filtres.": "No dataset matches these filters.",
  "Pagination": "Pagination",
  "Page {page} sur {count}": "Page {page} of {count}",
  "Ajouter aux favoris": "Add to favorites",
  "Retirer des favoris": "Remove from favorites",

  // Fiche
  "Retour à la marketplace": "Back to the marketplace",
  "Fiche indisponible": "Listing unavailable",
  "Ce dataset n’est pas en ligne sur la marketplace : il a pu être mis en pause, expirer ou être retiré.":
    "This dataset is not online on the marketplace: it may have been paused, expired or removed.",
  "Aucune description fournie.": "No description provided.",
  "Données": "Data",
  "Les noms et types des colonnes restent dans le fichier chiffré : ils ne sont pas publiés.":
    "Column names and types stay inside the encrypted file: they are not published.",
  "Modèle d’entraînement": "Training model",
  "Ce qu’il fait": "What it does",
  "Ce que vous recevez": "What you receive",
  "Le modèle entraîné : ses coefficients et ses métriques de qualité.": "The trained model: its coefficients and quality metrics.",
  "Statistiques publiques": "Public statistics",
  "Publication": "Published",
  "Emprunts réglés au fournisseur": "Loans settled to the provider",
  "Un emprunt terminé est réglé au fournisseur ou remboursé ; un remboursement suit un échec de l’entraînement ou un entraînement jamais lancé.":
    "A completed loan is either settled to the provider or refunded; a refund follows a failed training or a training that was never started.",
  "Aucun frais de calcul n’est prélevé : le montant verrouillé est rendu en entier.":
    "No compute fee is charged: the locked amount is returned in full.",
  "Le devis précise ce qui est retenu en cas d’échec, avant tout paiement.":
    "The quote states what is retained if training fails, before any payment.",
  "Emprunt indisponible : l’attestation de vérification du fournisseur est absente ou expirée.":
    "Borrowing unavailable: the provider’s verification attestation is missing or expired.",
  "Aucun emprunt terminé": "No completed loan yet",
  "{rate} % ({settled} sur {count} emprunts terminés)": "{rate}% ({settled} of {count} completed loans)",
  "Adresse": "Address",
  "Vérification": "Verification",
  "Vérifié": "Verified",
  "Non vérifié": "Not verified",
  "Statut indisponible": "Status unavailable",
  "Voir la preuve on-chain": "View the on-chain proof",
  "Ce que vous payez": "What you pay",
  "Frais de calcul indicatifs pour ce modèle (dernier devis ou tarif publié). Le montant exact est affiché dans le devis, avant tout paiement.":
    "Indicative compute fee for this model (latest quote or published rate). The exact amount is shown in the quote, before any payment.",
  "Indiqués dans le devis": "Shown in the quote",
  "Les frais de calcul et le total sont affichés dans le devis, avant tout paiement.":
    "The compute fee and the total are shown in the quote, before any payment.",
  "Ce que vous obtenez": "What you get",
  "Un accès à cette donnée et un entraînement dans l’enclave. Vous recevez le modèle entraîné, jamais la donnée. Chaque nouvel entraînement est un nouvel emprunt.":
    "Access to this data and one training run inside the enclave. You receive the trained model, never the data. Each new training is a new loan.",
  "En cas d’échec": "If it fails",
  "Seul le calcul réellement consommé est retenu, le reste est remboursé.":
    "Only the compute actually consumed is retained; the rest is refunded.",
  "Sans règlement après 1 jour, vous récupérez vos fonds depuis la page Entraîner.":
    "If the loan is not settled after 1 day, you can recover your funds from the Train page.",
  "Sans règlement après {days} jours, vous récupérez vos fonds depuis la page Entraîner.":
    "If the loan is not settled after {days} days, you can recover your funds from the Train page.",
  "Sans règlement à l’échéance de l’escrow, vous récupérez vos fonds depuis la page Entraîner.":
    "If the loan is not settled by the escrow deadline, you can recover your funds from the Train page.",

  // Emprunt depuis la fiche
  "La consultation est ouverte à tous. Pour emprunter, connectez votre wallet et signez : la connexion est demandée au clic.":
    "Anyone can browse. To borrow, connect your wallet and sign in: you are asked when you click Borrow.",
  "Emprunt enregistré. Lancez l’entraînement depuis la page": "Loan recorded. Start the training from the",

  // Erreurs de la route publique (src/lib/marketplace/query.ts)
  "Paramètre de recherche répété": "Repeated search parameter",
  "Recherche invalide (100 caractères au plus)": "Invalid search (100 characters maximum)",
  "Catégorie inconnue": "Unknown category",
  "Modèle inconnu": "Unknown model",
  "Prix invalide": "Invalid price",
  "Fourchette de prix invalide": "Invalid price range",
  "Nombre de lignes invalide": "Invalid number of rows",
  "Fourchette de lignes invalide": "Invalid row range",
  "Filtre fournisseur invalide": "Invalid provider filter",
  "Tri inconnu": "Unknown sort order",
  "Page invalide": "Invalid page",
  "Configuration du réseau incohérente": "Inconsistent network configuration",
};
