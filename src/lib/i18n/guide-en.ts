/**
 * Traductions du guide Sirio (personnage animé du parcours d'accueil). Fichier séparé, fusionné
 * dans `EN_MESSAGES`. `{name}` est le nom du personnage, `{token}` le jeton de règlement du
 * réseau, jamais écrits en dur.
 */
export const GUIDE_MESSAGES_EN: Record<string, string> = {
  // Boutons et libellés
  "Passer le guide": "Skip the guide",
  "C’est parti": "Let’s go",
  "Terminer": "Finish",
  "Réduire le guide": "Minimize the guide",
  "Ouvrir {name}": "Open {name}",
  "Poser une question": "Ask a question",
  "Élément mis en avant par le guide": "Element highlighted by the guide",
  "J’attends que ce soit fait…": "I’ll wait until it’s done…",
  "{name}, le guide Sirius": "{name}, the Sirius guide",

  // Accueil
  "Salut, je suis {name}.": "Hi, I’m {name}.",
  "Sirius permet d’entraîner un modèle sur des données confidentielles sans jamais les voir, et d’être payé quand on prête les siennes.":
    "Sirius lets you train a model on confidential data without ever seeing it, and get paid when you lend yours.",
  "Je te montre comment ça marche en quelques étapes — tu peux passer à tout moment.":
    "I’ll show you how it works in a few steps — you can skip at any time.",

  // Connexion
  "Connecte un wallet": "Connect a wallet",
  "Ton wallet est ton compte Sirius : pas d’e-mail ni de mot de passe. Clique sur Connexion, puis choisis ton wallet.":
    "Your wallet is your Sirius account: no email, no password. Click Connect, then pick your wallet.",
  "Wallet connecté. Maintenant, prouvons qu’il est bien à toi.": "Wallet connected. Now let’s prove it’s yours.",
  "Signe pour te connecter": "Sign to sign in",
  "Clique sur Se connecter : ton wallet te demande de signer un message. C’est gratuit, ce n’est pas une transaction, et ça prouve que ce wallet est bien à toi.":
    "Click Sign in: your wallet asks you to sign a message. It’s free, it’s not a transaction, and it proves you own this wallet.",
  "Bravo, tu es connecté·e !": "Well done, you’re signed in!",

  // Vérification
  "Sur mainnet, chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde.":
    "On mainnet, every lender and borrower is verified on-chain: it protects everyone’s data and money.",
  "Chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde.":
    "Every lender and borrower is verified on-chain: it protects everyone’s data and money.",
  "Je regarde si ton wallet est déjà vérifié…": "Checking whether your wallet is already verified…",
  "Une seule transaction à confirmer dans ton wallet, et c’est fait.": "One transaction to confirm in your wallet, and you’re done.",
  "Il te faut un peu d’ETH pour payer le gas de cette transaction : ajoute des fonds d’abord, je t’attends ici.":
    "You need a little ETH to pay the gas for this transaction: add funds first, I’ll wait here.",
  "L’accès instantané n’est pas ouvert : colle le code d’invitation reçu de l’équipe, ou écris-nous.":
    "Instant access is not open: paste the invitation code you received from the team, or write to us.",
  "Je n’arrive pas à lire ton statut pour l’instant. Tu peux le vérifier sur la page Vérification, ou continuer.":
    "I can’t read your status right now. You can check it on the Verification page, or continue.",
  "Ton wallet est vérifié. Je te fais visiter ?": "Your wallet is verified. Shall I show you around?",

  // Tour du menu (« Phala » est un nom propre, identique dans les deux langues)
  "Phala": "Phala",
  "Parcours les datasets publiés, et emprunte celui qu’il te faut : le prix est bloqué en escrow, jamais versé d’avance.":
    "Browse the published datasets and borrow the one you need: the price is locked in escrow, never paid upfront.",
  "Lance tes entraînements et récupère tes modèles ici. Après le paiement, compte ~15 minutes de finalité avant de lancer le job.":
    "Run your training jobs and collect your models here. After payment, allow ~15 minutes of finality before running the job.",
  "Dépose un CSV : il est chiffré dans ton navigateur, et tu es payé·e en {token} à chaque entraînement réglé.":
    "Upload a CSV: it is encrypted in your browser, and you get paid in {token} on every settled training run.",
  "Tes emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne.":
    "Your borrowings, settlements and refunds, each verifiable on the chain explorer.",
  "L’enclave qui entraîne sans voir les données : son identité est attestée à chaque requête.":
    "The enclave that trains without seeing the data: its identity is attested on every request.",
  "Ton solde, ta liste « Bien démarrer » et tes raccourcis. On y revient quand tu veux.":
    "Your balance, your “Get started” list and your shortcuts. Come back whenever you like.",
  "Tu sais tout !": "You know it all!",
  "Je reste dans ma bulle en bas à droite : clique dessus pour me poser une question ou revoir la visite.":
    "I’ll stay in my bubble at the bottom right: click it to ask me a question or replay the tour.",

  // Visites de page (src/lib/guide/pages.ts) : interface
  "Passer la visite": "Skip the tour",
  "Visite de cette page": "Tour of this page",
  "Progression de la visite": "Tour progress",
  "Marketplace": "Marketplace",
  "Wallet": "Wallet",
  "Visite guidée": "Guided tour",
  "Fiche d’un dataset": "Dataset page",
  "Vérification du wallet": "Wallet verification",

  // Tableau de bord
  "Ton tableau de bord": "Your dashboard",
  "Tout ce qui compte pour ton compte en un coup d’œil : ta liste de départ, ton solde et tes raccourcis.":
    "Everything that matters for your account at a glance: your starter checklist, your balance and your shortcuts.",
  "Bien démarrer": "Get started",
  "Cette liste suit l’état réel de ton compte — connexion, vérification, fonds — et disparaît quand tout est fait.":
    "This list follows the real state of your account — sign-in, verification, funds — and disappears once everything is done.",
  "Ton solde": "Your balance",
  "Ton solde en {token}, et l’ETH qu’il te reste pour le gas. « Ajouter des fonds » ouvre les options de dépôt.":
    "Your {token} balance, and the ETH you have left for gas. “Add funds” opens the deposit options.",
  "À retirer": "To withdraw",
  "Les règlements et remboursements arrivent d’abord ici, dans l’escrow : retire-les pour les ramener dans ton wallet.":
    "Settlements and refunds land here first, in the escrow: withdraw them to move them to your wallet.",
  "Confiance EVM": "EVM trust",
  "Tes emprunts réglés, remboursés et tes preuves on-chain, côté fournisseur et côté emprunteur.":
    "Your settled and refunded loans and your on-chain proofs, as a provider and as a borrower.",
  "Raccourcis": "Shortcuts",
  "Marketplace pour emprunter, Entraîner pour suivre tes jobs, Mes datasets pour publier les tiens.":
    "Marketplace to borrow, Train to follow your jobs, My datasets to publish your own.",

  // Entraîner
  "Ici tu suis tes emprunts et tes entraînements : chaque carte est un prêt, du paiement jusqu’au modèle livré.":
    "Here you follow your borrowings and training runs: each card is a loan, from payment to the delivered model.",
  "Tes propres données": "Your own data",
  "Entraîner sur tes données sans escrow est réservé à l’équipe pendant la bêta : écris-nous pour l’essayer.":
    "Training on your own data without escrow is reserved to the team during the beta: write to us to try it.",
  "Mes entraînements": "My training runs",
  "Après un emprunt, attends la finalité du paiement (~15 min), puis « Lancer le job (TEE) ». Un modèle réglé se vérifie et se télécharge ici ; un prêt jamais réglé se rembourse après son délai.":
    "After borrowing, wait for payment finality (~15 min), then “Run job (TEE)”. A settled model is verified and downloaded here; a loan never settled is refunded after its deadline.",

  // Phala
  "Phala, l’enclave": "Phala, the enclave",
  "Le calcul tourne dans une enclave Phala (Intel TDX) : l’identité du code est attestée à chaque requête, et personne ne voit tes données.":
    "Computation runs inside a Phala enclave (Intel TDX): the code’s identity is attested on every request, and nobody sees your data.",
  "L’attestation": "The attestation",
  "Ce lien ouvre l’attestation du runner : la preuve que le code attendu tourne bien dans l’enclave.":
    "This link opens the runner’s attestation: the proof that the expected code is running inside the enclave.",
  "Jeux d’exemple": "Sample datasets",
  "Un dataset synthétique prêt à l’emploi pour essayer sans rien préparer.":
    "A ready-to-use synthetic dataset to try things out without preparing anything.",
  "Préparer l’entraînement": "Prepare the training",
  "Ton CSV, le modèle et la colonne à prédire. Le fichier est chiffré dans ton navigateur ; le calcul est offert pendant la démo.":
    "Your CSV, the model and the column to predict. The file is encrypted in your browser; the compute is free during the demo.",
  "Mes résultats": "My results",
  "Tes modèles entraînés restent dans ce navigateur : télécharge-les pour les garder ailleurs.":
    "Your trained models stay in this browser: download them to keep them elsewhere.",
  "L’espace Phala": "The Phala workspace",
  "La démo s’ouvre dans un espace dédié ; l’entraînement standard reste sur la page Entraîner.":
    "The demo opens in a dedicated workspace; standard training stays on the Train page.",

  // Marketplace
  "La marketplace": "The marketplace",
  "Les datasets publiés par les fournisseurs. Un emprunt, c’est un entraînement dans l’enclave : tu reçois le modèle, jamais la donnée.":
    "The datasets published by providers. A loan is one training run in the enclave: you receive the model, never the data.",
  "Rechercher": "Search",
  "Par nom ou description ; la recherche part après une pause de frappe, ou sur Entrée.":
    "By name or description; the search runs after a typing pause, or on Enter.",
  "Filtrer": "Filter",
  "Catégorie, modèle, prix total, taille — et « Vérifiés uniquement » pour ne garder que les fournisseurs attestés.":
    "Category, model, total price, size — and “Verified KYB only” to keep only attested providers.",
  "Trier": "Sort",
  "Plus récents, plus empruntés ou prix croissant.": "Most recent, most borrowed or lowest price first.",
  "Les fiches": "The cards",
  "Prix affiché frais de calcul compris quand ils sont connus, lignes, colonnes, badge « vérifié ». L’étoile garde un favori ; clique sur une fiche pour l’ouvrir et emprunter.":
    "Price shown with compute fees when they are known, rows, columns, “verified” badge. The star keeps a favourite; click a card to open it and borrow.",

  // Fiche d’un dataset
  "Tout ce qui est public sur ce dataset avant d’emprunter. Les colonnes elles-mêmes restent chiffrées.":
    "Everything public about this dataset before you borrow. The columns themselves stay encrypted.",
  "Les données": "The data",
  "Lignes, colonnes, taille et catégorie. Les noms et types des colonnes ne sont pas publiés.":
    "Rows, columns, size and category. Column names and types are not published.",
  "Le modèle": "The model",
  "Fixé par le fournisseur à la publication : c’est ce modèle entraîné que tu recevras, avec ses coefficients et ses métriques.":
    "Set by the provider at publication: this is the trained model you will receive, with its coefficients and metrics.",
  "Statistiques": "Statistics",
  "Emprunts passés et part réglée au fournisseur : un signal sur la fiabilité du dataset.":
    "Past loans and the share settled to the provider: a signal of the dataset’s reliability.",
  "Ce que tu paies": "What you pay",
  "La part du fournisseur plus les frais de calcul. Le montant exact est dans le devis, avant tout paiement ; le gas se paie à part, en ETH.":
    "The provider’s share plus compute fees. The exact amount is in the quote, before any payment; gas is paid separately, in ETH.",
  "Emprunter": "Borrow",
  "Une transaction bloque le prix en escrow. La connexion et la vérification du wallet ne sont demandées qu’à ce moment-là.":
    "One transaction locks the price in escrow. Sign-in and wallet verification are only requested at that point.",

  // Mes datasets
  "Les datasets importés depuis ce wallet : leur état, leurs emprunts et ce qu’ils t’ont rapporté.":
    "The datasets uploaded from this wallet: their status, their loans and what they earned you.",
  "Par date, par revenus ou par emprunts.": "By date, by revenue or by loans.",
  "La tuile ouvre l’import : CSV chiffré dans ton navigateur, puis prix et durée de publication.":
    "The tile opens the upload: CSV encrypted in your browser, then price and listing duration.",
  "Tes fiches": "Your cards",
  "La pastille dit l’état — brouillon, en ligne, emprunté, en pause — et un brouillon se publie depuis son bouton.":
    "The pill shows the status — draft, online, borrowed, paused — and a draft is published from its button.",

  // Publier un dataset
  "Deux étapes : la donnée, puis le prix et la publication. Rien ne quitte ton navigateur en clair.":
    "Two steps: the data, then the price and publication. Nothing leaves your browser unencrypted.",
  "Les étapes": "The steps",
  "La donnée d’abord — fichier, nom, catégorie, profil —, puis le prix et la durée de publication.":
    "The data first — file, name, category, profile — then the price and the listing duration.",
  "Ton CSV": "Your CSV",
  "Glisse ton fichier ou charge le jeu d’exemple. Il reste sur ton appareil tant que tu ne publies pas.":
    "Drop your file or load the sample dataset. It stays on your device until you publish.",
  "Catégorie et profil": "Category and profile",
  "La catégorie sert de filtre sur la marketplace ; le profil d’entraînement est vérifié sur le CSV puis verrouillé on-chain.":
    "The category is a marketplace filter; the training profile is checked against the CSV, then locked on-chain.",
  "Ton gain": "Your earnings",
  "Ce que tu veux gagner par emprunt, en {token}. Les frais de calcul s’ajoutent pour l’emprunteur.":
    "What you want to earn per loan, in {token}. Compute fees are added for the borrower.",
  "Durée de publication": "Listing duration",
  "Le temps pendant lequel le dataset reste empruntable ; tu pourras le mettre en pause avant.":
    "How long the dataset stays borrowable; you can pause it earlier.",
  "Publier": "Publish",
  "Chiffrement, scellement dans l’enclave, IPFS, puis le titre on-chain : une transaction à signer dans ton wallet.":
    "Encryption, sealing in the enclave, IPFS, then the on-chain title: one transaction to sign in your wallet.",

  // Explorer
  "En chiffres": "In numbers",
  "Emprunts, datasets empruntés, réglés, remboursés : le résumé de ton activité on-chain.":
    "Borrowings, datasets borrowed, settled, refunded: the summary of your on-chain activity.",
  "Un emprunt": "A borrowing",
  "Titre du dataset, lock, attestation TEE, reçu d’audit, règlement ou remboursement : chaque preuve a son lien « Vérifier ».":
    "Dataset title, lock, TEE attestation, audit receipt, settlement or refund: every proof has its “Verify” link.",

  // Wallet
  "Ton wallet": "Your wallet",
  "Solde, gas, dépôt, retrait : tout ce qui touche à l’argent passe ici — et reste dans ton wallet ou dans l’escrow, jamais chez Sirius.":
    "Balance, gas, deposits, withdrawals: everything about money goes through here — and stays in your wallet or in the escrow, never with Sirius.",
  "Solde et gas": "Balance and gas",
  "Ton solde en {token} et l’ETH pour le gas. « Ajouter des fonds » : par carte, depuis un autre wallet ou depuis une autre chaîne.":
    "Your {token} balance and the ETH for gas. “Add funds”: by card, from another wallet or from another chain.",
  "Ton solde en {token} et l’ETH pour le gas. « Ajouter des fonds » envoie des jetons de test et un peu d’ETH de test.":
    "Your {token} balance and the ETH for gas. “Add funds” sends test tokens and a little test ETH.",
  "Ton compte": "Your account",
  "Le réseau du site, ton adresse à copier, et l’état de ta session signée.":
    "The site’s network, your address to copy, and the state of your signed session.",
  "Les règlements et remboursements arrivent d’abord dans l’escrow : « Retirer » les ramène dans ton wallet, contre un peu de gas.":
    "Settlements and refunds land in the escrow first: “Withdraw” moves them to your wallet, for a little gas.",

  // KYB
  "Ton statut": "Your status",
  "Lu dans le registre de vérification on-chain : vérifié, avec la date d’expiration, ou non vérifié.":
    "Read from the on-chain verification registry: verified, with its expiry date, or not verified.",
  "Obtenir l’accès": "Get access",
  "L’accès instantané quand il est ouvert — une transaction —, sinon le code d’invitation reçu de l’équipe.":
    "Instant access when it is open — one transaction — otherwise the invitation code received from the team.",
  "Bientôt": "Coming soon",
  "Ce qui arrive ensuite pour la vérification.": "What comes next for verification.",
};
