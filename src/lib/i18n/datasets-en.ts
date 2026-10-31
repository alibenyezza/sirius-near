/**
 * Traductions de la slice N1 « Mes datasets » : mosaïque, fiche d'un dataset, statistiques,
 * réglages et messages d'erreur des routes privées (`/api/datasets/[id]/settings/**`,
 * `/api/datasets/[id]/stats`). Fichier séparé, fusionné dans `EN_MESSAGES`, pour que les
 * autres slices qui complètent `english.ts` et `errors-en.ts` ne se marchent pas dessus.
 * Les clés déjà traduites ailleurs (« Mes datasets », « Emprunts », « Annuler »…) ne sont
 * pas redéfinies ici.
 */
export const DATASETS_MESSAGES_EN: Record<string, string> = {
  // Mosaïque
  "Date": "Date",
  "Revenus": "Revenue",
  "{count} dataset(s), dont {online} en ligne ou emprunté(s).": "{count} dataset(s), {online} online or borrowed.",
  "Emprunts et revenus indisponibles pour le moment : {reason}": "Borrows and revenue are unavailable right now: {reason}",
  "Seuls les {count} datasets les plus récents sont affichés et triés.": "Only the {count} most recent datasets are shown and sorted.",
  "Aucun dataset pour l’instant : publie le premier avec la tuile ci-dessus.": "No datasets yet: publish your first one with the tile above.",
  "Brouillon : publication non terminée.": "Draft: publication not finished.",
  "Publication en cours.": "Publication in progress.",
  "Privé : visible par toi seul.": "Private: visible only to you.",
  "Archivé par Sirius : plus disponible à l’emprunt.": "Archived by Sirius: no longer available to borrow.",
  "Suppression à finaliser.": "Deletion to finalize.",
  "En pause : hors marketplace.": "Paused: hidden from the marketplace.",
  "Annonce expirée.": "Listing expired.",

  // Fiche : en-tête et description
  "Ce dataset n’existe pas ou n’appartient pas au wallet connecté.": "This dataset does not exist or does not belong to the connected wallet.",
  "Annonce expirée : prolonge-la pour que le dataset reste publié.": "Listing expired: extend it to keep the dataset published.",
  "En ligne : visible sur la marketplace et empruntable.": "Online: visible on the marketplace and available to borrow.",
  "En pause : le dataset n’apparaît plus sur la marketplace. Une personne qui a déjà son lien direct peut encore l’emprunter.":
    "Paused: the dataset no longer appears on the marketplace. Someone who already has its direct link can still borrow it.",
  "Privé : hors marketplace et non empruntable par des tiers.": "Private: hidden from the marketplace and not available to other wallets.",
  "Archivé par Sirius : plus disponible à l’emprunt. L’ancrage on-chain reste consultable.":
    "Archived by Sirius: no longer available to borrow. The on-chain anchor remains verifiable.",
  "Clé détruite. La désactivation du titre on-chain reste à finaliser.": "Key destroyed. Deactivation of the on-chain title still needs to be finalized.",
  "Détruit : la clé active est supprimée, le dataset est irrécupérable.": "Destroyed: the active key is deleted and the dataset cannot be recovered.",
  "Au moins un emprunt est en cours.": "At least one borrow is in progress.",
  "Pas de description.": "No description.",
  "Créé le": "Created on",
  "Dernière mise en ligne": "Last listed on",
  "Prix": "Price",
  "Ce que tu reçois par emprunt réglé. Les frais de calcul de l’enclave s’ajoutent pour l’emprunteur.":
    "What you receive per settled borrow. The enclave compute fee is added on top for the borrower.",
  "Le prix n’est pas modifiable : il est inscrit dans le reçu signé par l’enclave au scellement du dataset. Pour changer de prix, détruis le dataset et publie-le à nouveau.":
    "The price cannot be changed: it is written in the receipt signed by the enclave when the dataset was sealed. To change the price, destroy the dataset and publish it again.",

  // Fiche : statistiques
  "Statistiques": "Statistics",
  "Statistiques indisponibles": "Statistics unavailable",
  "Statistiques indisponibles pour le moment : {reason}": "Statistics are unavailable right now: {reason}",
  "En cours": "In progress",
  "Dernier emprunt": "Last borrow",
  "Aucun": "None",
  "Revenus gagnés": "Revenue earned",
  "Bloqué dans l’escrow": "Locked in escrow",
  "Entraînements livrés": "Trainings delivered",
  "Remboursés (échec ou délai dépassé)": "Refunded (failed or timed out)",
  "Les revenus réglés sont crédités sur ton wallet dans l’escrow, tous datasets confondus : retraits et solde à retirer sont sur la page":
    "Settled revenue is credited to your wallet in the escrow, across all datasets: withdrawals and the balance to withdraw are on the page",
  "{count} emprunt(s) au montant illisible, exclu(s) des totaux.": "{count} borrow(s) with an unreadable amount, excluded from the totals.",
  "Statistiques calculées sur les 5 000 prêts les plus récents, réservations comprises.": "Statistics computed on the 5,000 most recent loans, reservations included.",
  "Emprunts par semaine (8 dernières semaines, UTC)": "Borrows per week (last 8 weeks, UTC)",
  "7 j. depuis le {date}": "7 days from {date}",

  // Fiche : publication du titre (brouillons)
  "Publication du titre EVM": "EVM title publication",
  "Le titre EVM de ce dataset n’est pas encore publié.": "This dataset’s EVM title is not published yet.",

  // Fiche : nom et description
  "Nom et description": "Name and description",
  "Enregistrer": "Save",
  "Enregistrement…": "Saving…",
  "Enregistrement impossible": "Unable to save",
  "Modifications enregistrées.": "Changes saved.",

  // Fiche : publication sur la marketplace
  "Publication sur la marketplace": "Marketplace listing",
  "Fin de l’annonce : {date}": "Listing ends: {date}",
  "Annonce sans date de fin (publiée avant la durée de publication).": "Listing without an end date (published before listing durations existed).",
  "Mettre en pause": "Pause",
  "Mise en pause…": "Pausing…",
  "Remettre en ligne": "Put back online",
  "Remise en ligne…": "Putting back online…",
  "La pause retire le dataset de la marketplace. Elle n’arrête pas les emprunts en cours, et une personne qui a déjà son lien direct peut encore l’emprunter.":
    "Pausing removes the dataset from the marketplace. It does not stop borrows in progress, and someone who already has its direct link can still borrow it.",
  "Annonce expirée : prolonge-la avant de la remettre en ligne.": "Listing expired: extend it before putting it back online.",
  "Prolonger de": "Extend by",
  "{count} jours": "{count} days",
  "Prolonger l’annonce": "Extend listing",
  "Prolongation…": "Extending…",
  "Prolongation impossible": "Unable to extend the listing",
  "La durée s’ajoute à la fin actuelle, ou à aujourd’hui si l’annonce a expiré. Au plus 365 jours à l’avance.":
    "The duration is added to the current end date, or to today if the listing has expired. At most 365 days ahead.",
  "Dataset mis en pause.": "Dataset paused.",
  "Dataset remis en ligne.": "Dataset back online.",
  "Rendre privé": "Make private",
  "Déploiement de démonstration : les datasets restent hors marketplace.": "Demo deployment: datasets stay off the marketplace.",
  "Passage en privé…": "Making private…",
  "Dataset rendu privé.": "Dataset made private.",
  "« Rendre privé » ferme aussi l’emprunt par lien direct. Ce n’est pas possible tant qu’un emprunt est en cours ou réservé.":
    "“Make private” also closes borrowing through the direct link. It is not possible while a borrow is in progress or reserved.",
  "Visibilité impossible pour ce dataset": "Visibility change not allowed for this dataset",
  "Annonce prolongée.": "Listing extended.",

  // Fiche : consentement
  "Amélioration des modèles": "Model improvement",
  "Tu as autorisé Sirius à utiliser ce dataset, uniquement dans l’enclave, pour évaluer et développer de nouveaux modèles (le {date}, texte {version}).":
    "You allowed Sirius to use this dataset, inside the enclave only, to evaluate and develop new models (on {date}, text {version}).",
  "Retirer mon consentement": "Withdraw my consent",
  "Le retrait vaut pour les usages futurs. Il ne peut pas être annulé depuis cette page.":
    "Withdrawal applies to future use. It cannot be undone from this page.",
  "Confirmer le retrait": "Confirm withdrawal",
  "Retrait…": "Withdrawing…",
  "Consentement retiré le {date}.": "Consent withdrawn on {date}.",
  "Consentement retiré.": "Consent withdrawn.",
  "Tu n’as pas autorisé Sirius à utiliser ce dataset pour développer de nouveaux modèles.":
    "You have not allowed Sirius to use this dataset to develop new models.",
  "Retrait du consentement impossible": "Unable to withdraw consent",

  // Fiche : destruction
  "Destruction définitive": "Permanent destruction",
  "Détruit la clé active et désactive le titre on-chain. Le dataset devient irrécupérable. Les sauvegardes et les modèles déjà livrés ne sont pas effacés.":
    "Destroys the active key and deactivates the on-chain title. The dataset can no longer be recovered. Backups and models already delivered are not erased.",
  "Vérifie le titre dans le registre EVM courant et finalise la suppression. Les éventuels anciens registres ne seront pas modifiés.":
    "Check the title in the current EVM registry and finalize the deletion. Any previous registries will not be modified.",
  "Détruire ce dataset…": "Destroy this dataset…",
  "Finaliser la suppression…": "Finalize deletion…",
  "Pour confirmer, tape le nom du dataset : {name}": "To confirm, type the dataset name: {name}",
  "Détruire définitivement": "Destroy permanently",
  "Suppression enregistrée.": "Deletion recorded.",

  // Erreurs des routes privées (src/lib/datasets/manage.ts et routes)
  "Chargement du dataset impossible": "Unable to load the dataset",
  "Seul un dataset en ligne peut être mis en pause": "Only an online dataset can be paused",
  "Remise en ligne impossible pour ce dataset": "This dataset cannot be put back online",
  "Annonce expirée : prolonge-la avant de la remettre en ligne": "Listing expired: extend it before putting it back online",
  "Durée de prolongation invalide (7, 30 ou 90 jours)": "Invalid extension (7, 30 or 90 days)",
  "Prolongation impossible pour ce dataset": "This dataset’s listing cannot be extended",
  "Cette annonce n'a pas de date d'expiration": "This listing has no end date",
  "Prolongation limitée à 365 jours à l'avance": "Listings can be extended at most 365 days ahead",
  "Champ de réglage inconnu": "Unknown setting field",
  "Action de publication inconnue": "Unknown listing action",
  "Action de consentement inconnue": "Unknown consent action",
  "Le prix n'est pas modifiable : il est inscrit dans le reçu signé par l'enclave": "The price cannot be changed: it is written in the receipt signed by the enclave",
  "Champ de dataset non modifiable": "This dataset field cannot be changed",
  "Nom trop long (120 caractères maximum)": "Name too long (120 characters maximum)",
  "Nom invalide : caractères invisibles ou de contrôle interdits": "Invalid name: invisible or control characters are not allowed",
  "Nom invalide : au moins une lettre ou un chiffre": "Invalid name: it needs at least one letter or digit",
  "Description trop longue (2 000 caractères maximum)": "Description too long (2,000 characters maximum)",
  "Description invalide : caractères invisibles ou de contrôle interdits": "Invalid description: invisible or control characters are not allowed",
  "Aucune modification de dataset": "No dataset change",
  "Ce dataset n'est plus modifiable": "This dataset can no longer be changed",
  "Dataset modifié entre-temps : recharge la page": "The dataset changed in the meantime: reload the page",
  "Aucun consentement actif à retirer": "No active consent to withdraw",
};
