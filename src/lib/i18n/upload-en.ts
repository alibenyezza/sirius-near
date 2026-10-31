/**
 * Traductions de la publication en deux étapes (slice N2, docs/passage-mainnet/07-upload.md) :
 * formulaire `src/app/(app)/datasets/new/`, contrôle du CSV, termes de publication et
 * erreurs de la route de création. Fichier séparé, fusionné dans `EN_MESSAGES`, pour ne pas
 * entrer en conflit avec les autres slices qui complètent `english.ts`.
 *
 * Le texte du consentement et les catégories sont ceux du cahier des charges, au mot près.
 */
export const UPLOAD_MESSAGES_EN: Record<string, string> = {
  // Catégories (liste fixe, identifiants stockés en anglais)
  "Finance": "Finance",
  "Santé": "Health",
  "Commerce": "Commerce",
  "Industrie": "Industry",
  "Mobilité": "Mobility",
  "Énergie": "Energy",
  "Marketing": "Marketing",
  "Autre": "Other",

  // Consentement (07-upload.md)
  "Autoriser Sirius à utiliser ce dataset, uniquement dans l’enclave, pour évaluer et développer de nouveaux modèles. Vous pouvez retirer ce consentement à tout moment pour les usages futurs.":
    "Allow Sirius to use this dataset, inside the enclave only, to evaluate and develop new models. You can withdraw this consent at any time for future use.",

  // En-tête et étapes
  "Étape {step} / 2": "Step {step} of 2",
  "Étapes": "Steps",
  "La donnée": "Your data",
  "Prix et publication": "Price and publication",

  // Étape 1 — fichier
  "Glisse ton CSV ici ou choisis un fichier. Il reste dans ton navigateur tant que tu ne publies pas.":
    "Drop your CSV here or choose a file. It stays in your browser until you publish.",
  "Lecture du fichier…": "Reading the file…",
  "Fichier accepté par le contrôle du navigateur.": "File accepted by the browser check.",
  "Lignes de données": "Data rows",
  "Colonnes numériques": "Numeric columns",
  "Colonne cible": "Target column",
  "L’enclave entraîne sur la dernière colonne numérique du fichier et utilise les autres colonnes numériques comme variables ({count}). Réordonne les colonnes si la cible n’est pas la bonne.":
    "The enclave trains on the last numeric column of the file and uses the other numeric columns as input features ({count}). Reorder the columns if the target is not the right one.",
  "Voir les colonnes numériques": "Show numeric columns",
  "Catégorie": "Category",
  "Choisir une catégorie": "Choose a category",
  "Obligatoire : elle sert de filtre sur la marketplace.": "Required: it is used as a marketplace filter.",
  "Continuer vers le prix": "Continue to pricing",
  "Un fichier accepté, un nom et une catégorie sont nécessaires pour continuer.":
    "An accepted file, a name and a category are required to continue.",

  // Refus du CSV (raison exacte)
  "Fichier vide.": "The file is empty.",
  "Fichier trop volumineux : {size} ({bytes} octets), maximum {max}.": "File too large: {size} ({bytes} bytes), maximum {max}.",
  "Fichier illisible : ce n’est pas un CSV valide.": "Unreadable file: this is not a valid CSV.",
  "Trop de lignes : au plus {max} lignes, en-tête compris.": "Too many rows: at most {max} rows, header included.",
  "Trop de colonnes : au plus {max}.": "Too many columns: at most {max}.",
  "Une cellule dépasse la taille autorisée.": "A cell exceeds the allowed size.",
  "Le fichier doit contenir un en-tête et au moins une ligne de données.": "The file must contain a header and at least one data row.",
  "En-tête invalide : chaque colonne doit avoir un nom, sans doublon.": "Invalid header: every column needs a name, with no duplicates.",
  "Au moins deux colonnes entièrement numériques sont requises ({found} détectée(s)).":
    "At least two fully numeric columns are required ({found} detected).",
  "Trop de variables numériques : {found}, maximum {max} en plus de la cible.":
    "Too many numeric features: {found}, maximum {max} in addition to the target.",
  "Pas assez de lignes : {rows}, minimum {min} pour ce nombre de variables.":
    "Not enough rows: {rows}, minimum {min} for this number of features.",
  "Budget de calcul dépassé : réduis le nombre de lignes ou de variables.":
    "Compute budget exceeded: reduce the number of rows or features.",
  "Pour la régression logistique, la colonne cible « {target} » doit contenir uniquement 0 et 1, avec les deux classes.":
    "For logistic regression, the target column “{target}” must contain only 0 and 1, with both classes present.",

  // Transition de sécurisation
  "Sécurisation sur ton appareil": "Securing on your device",
  "Fichier lu dans la mémoire de ce navigateur, sans envoi.": "File loaded into this browser’s memory, nothing sent.",
  "Empreinte SHA-256 calculée sur ton appareil.": "SHA-256 fingerprint computed on your device.",
  "Le chiffrement aura lieu ici, à la publication, pour la clé de l’enclave : la donnée en clair ne quitte jamais ton navigateur.":
    "Encryption happens here, at publication, for the enclave key: your plain data never leaves your browser.",
  "Empreinte locale : {fingerprint}": "Local fingerprint: {fingerprint}",

  // Étape 2 — prix
  "Ce que je veux gagner par emprunt ({symbol})": "What I want to earn per loan ({symbol})",
  "Entre {minimum} et {maximum} {symbol}, au plus {decimals} décimales. Aucune commission supplémentaire pendant la bêta.":
    "Between {minimum} and {maximum} {symbol}, up to {decimals} decimals. No extra commission during the beta.",
  "Montant invalide : vérifie les bornes et le nombre de décimales.": "Invalid amount: check the bounds and the number of decimals.",
  "Frais de calcul du tarif en vigueur ({version}) pour le profil {model}. L’emprunteur paie ta part plus ces frais ; tu reçois ta part à chaque emprunt réglé.":
    "Compute fee of the tariff in force ({version}) for the {model} profile. The borrower pays your share plus this fee; you receive your share for each settled loan.",
  "Le tarif en vigueur n’a pas pu être chargé : les frais de calcul ne peuvent pas être affichés. La publication est suspendue tant que la décomposition du prix ne peut pas être montrée. Réessaie dans quelques instants ou contacte-nous.":
    "The tariff in force could not be loaded, so the compute fee cannot be shown. Publication is paused until the price breakdown can be displayed. Try again shortly or contact us.",
  "Tu recevrais {amount} par emprunt réglé.": "You would receive {amount} per settled loan.",
  "Indique ton gain pour voir ce que paiera l’emprunteur. Minimum imposé par le tarif : {minimum}.": "Enter your share to see what the borrower will pay. Minimum set by the tariff: {minimum}.",
  "Publication suspendue : tarif indisponible.": "Publication paused: tariff unavailable.",
  "Aucun frais de calcul avec l’escrow actuel : l’emprunteur bloque exactement ta part, que tu reçois à chaque emprunt réglé.":
    "No compute fee with the current escrow: the borrower locks exactly your share, which you receive for each settled loan.",
  "Reprendre l’inscription on-chain": "Resume the on-chain registration",
  "Le gain doit atteindre le minimum imposé par le tarif.": "Your share must reach the minimum set by the tariff.",
  "Indique un gain valide pour publier.": "Enter a valid amount to publish.",

  // Étape 2 — durée et estimations
  "Durée de publication": "Listing duration",
  "{days} jours": "{days} days",
  "{days} jours (par défaut)": "{days} days (default)",
  "Mise en ligne pendant {listingDays} jours à compter de l’inscription on-chain (vers le {date}), renouvelable depuis la fiche du dataset. Le délai de sécurité de l’escrow est fixé par Sirius à {days} jours pour tous les datasets : si un emprunt n’est pas réglé dans ce délai, l’emprunteur récupère ses fonds.":
    "Listed for {listingDays} days from the on-chain registration (around {date}), renewable from the dataset page. The escrow safety delay is set by Sirius to {days} days for every dataset: if a loan is not settled within that time, the borrower gets their funds back.",
  "Estimations": "Estimates",
  "Taille chiffrée (environ)": "Encrypted size (approx.)",

  // Étape 2 — consentement et publication
  "Facultatif. Ton choix est enregistré avec sa date et la version du texte ({version}). La donnée n’est jamais déchiffrée hors de l’enclave, y compris pour cet usage. Tu pourras le retirer depuis la fiche du dataset.":
    "Optional. Your choice is recorded with its date and the text version ({version}). Data is never decrypted outside the enclave, including for this use. You will be able to withdraw it from the dataset page.",
  "Le dataset est scellé par l’enclave.": "The dataset is sealed by the enclave.",
  "Terminer l’inscription on-chain depuis Mes actifs data": "Finish the on-chain registration from My data assets",
  "Progression de la publication": "Publication progress",
  "Création du brouillon": "Creating the draft",
  "Chiffrement sur ton appareil": "Encrypting on your device",
  "Envoi et scellement par l’enclave": "Uploading and sealing in the enclave",
  "Inscription du titre on-chain": "Registering the title on-chain",
  "préparation du titre": "preparing the title",
  "signe la transaction dans ton wallet": "sign the transaction in your wallet",
  "attente de la confirmation": "waiting for confirmation",
  "en attente": "pending",
  "en cours": "in progress",
  "terminé": "done",
  "échoué": "failed",
  "← Retour à la donnée": "← Back to your data",
  "Publier le dataset": "Publish the dataset",

  // Route de création et contrôle de la réponse
  "Catégorie obligatoire": "Category required",
  "Durée de publication invalide (7, 30 ou 90 jours)": "Invalid listing duration (7, 30 or 90 days)",
  "Consentement invalide": "Invalid consent value",
  "Prix invalide (0.001 à 1 000 000 par emprunt)": "Invalid price (0.001 to 1,000,000 per loan)",
  "Délai de sécurité incohérent": "Inconsistent escrow safety delay",
  "Le brouillon a changé pendant sa création": "The draft changed while it was being created",
  "Le serveur a renvoyé un autre profil d’entraînement": "The server returned a different training profile",
  "Le serveur a renvoyé un autre prix": "The server returned a different price",
  "Le serveur a renvoyé une autre taille de fichier": "The server returned a different file size",
  "Le serveur a renvoyé d’autres termes de publication": "The server returned different publication terms",
};
