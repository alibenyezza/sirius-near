/**
 * Traductions de l'assistant Sirio : erreurs de la route `/api/assistant/chat` et interface du
 * panneau de chat. Fichier séparé, fusionné dans `EN_MESSAGES`.
 */
export const ASSISTANT_MESSAGES_EN: Record<string, string> = {
  // Démarrage
  "SIRIUS_ASSISTANT_ENABLED doit valoir true ou false": "SIRIUS_ASSISTANT_ENABLED must be true or false",
  "SIRIUS_ASSISTANT_ENABLED=true exige ANTHROPIC_API_KEY": "SIRIUS_ASSISTANT_ENABLED=true requires ANTHROPIC_API_KEY",
  "SIRIUS_ASSISTANT_ENABLED=true exige SIRIUS_ASSISTANT_SECRET : 32 caractères au moins": "SIRIUS_ASSISTANT_ENABLED=true requires SIRIUS_ASSISTANT_SECRET: at least 32 characters",
  "Trop de questions aujourd’hui depuis ce poste — réessaie demain": "Too many questions today from this device — try again tomorrow",

  // Route
  "Assistant indisponible": "Assistant unavailable",
  "Requête d’assistant invalide": "Invalid assistant request",
  "Message trop long": "Message too long",
  "Historique trop long": "Conversation too long",
  "Assistant indisponible aujourd’hui : plafond quotidien atteint": "Assistant unavailable today: daily limit reached",
  "Assistant très sollicité — réessaie dans un instant": "The assistant is busy — try again in a moment",
  "Assistant injoignable — réessaie plus tard": "The assistant cannot be reached — try again later",
  "Assistant momentanément indisponible — réessaie plus tard": "The assistant is temporarily unavailable — try again later",
  "Assistant indisponible pour le moment": "The assistant is unavailable right now",

  // Panneau de chat
  "Pose ta question sur Sirius": "Ask anything about Sirius",
  "Comment emprunter un dataset ?": "How do I borrow a dataset?",
  "Pourquoi attendre ~15 minutes ?": "Why wait ~15 minutes?",
  "Comment publier des données ?": "How do I publish data?",
  "Mes données sont-elles en sécurité ?": "Is my data safe?",
  "Écris ta question…": "Type your question…",
  "Envoyer la question": "Send question",
  "Sirio réfléchit…": "Sirio is thinking…",
  "Sirio ne peut pas répondre à cette demande. Pose une question sur Sirius, ou écris à l’équipe.":
    "Sirio can’t answer that request. Ask something about Sirius, or write to the team.",
  "Réponse coupée : pose une question plus précise.": "Answer cut short: ask a more specific question.",
  "Connexion perdue — réessaie.": "Connection lost — try again.",
  "Contacter l’équipe": "Contact the team",
  "Effacer la conversation": "Clear the conversation",
  "Réessayer": "Retry",
  "Sirio répond aux questions sur Sirius et l’utilisation du site. Il ne donne aucun conseil financier et ne demande jamais de clé privée.":
    "Sirio answers questions about Sirius and how to use the site. It gives no financial advice and never asks for a private key.",
  "Le chat n’est pas activé sur cette instance. Voici les réponses les plus demandées :":
    "Chat is not enabled on this instance. Here are the most common answers:",
  "Ouvre la Marketplace, choisis un dataset et clique sur Emprunter : le prix et le compute sont bloqués en escrow, puis l’entraînement tourne dans un TEE.":
    "Open the Marketplace, pick a dataset and click Borrow: the price and compute are locked in escrow, then training runs in a TEE.",
  "Après le paiement, la chaîne doit atteindre la finalité (~15 min) avant que le job puisse démarrer. Laisse la page Entraîner ouverte ou reviens cliquer sur Lancer le job.":
    "After payment, the chain must reach finality (~15 min) before the job can start. Keep the Train page open or come back and click Run job.",
  "Dans Mes datasets, importe un CSV : il est chiffré dans ton navigateur, puis publie son titre on-chain pour le rendre empruntable.":
    "In My datasets, upload a CSV: it is encrypted in your browser, then publish its on-chain title to make it borrowable.",
  "Les données brutes ne quittent jamais le chiffrement : l’entraînement tourne dans une enclave et l’emprunteur ne reçoit que le modèle.":
    "Raw data never leaves encryption: training runs inside an enclave and the borrower only receives the model.",
  "Conversation avec Sirio": "Conversation with Sirio",
  "Fermer le panneau": "Close panel",
  "Revoir la visite guidée": "Replay the guided tour",
  "Revoir la visite de cette page": "Replay this page’s tour",
  "Réduire le panneau": "Shrink the panel",
  "Agrandir le panneau": "Enlarge the panel",
  "Copier la réponse": "Copy the answer",
  "Réponse copiée": "Answer copied",
  "Copier": "Copy",
  "Copié": "Copied",
  "Questions suggérées": "Suggested questions",
  "Dernier message": "Latest message",
  "Arrêter la réponse": "Stop the answer",
  "Réponse interrompue.": "Answer stopped.",
  "Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne": "Enter to send · Shift+Enter for a new line",

  // Questions suggérées selon la page, et leurs réponses hors ligne
  "Combien de datasets sur la marketplace ?": "How many datasets are on the marketplace?",
  "Quels sont les plafonds de prêt ?": "What are the loan limits?",
  "Que veut dire le badge « vérifié » ?": "What does the “verified” badge mean?",
  "Le badge indique que le fournisseur du dataset a une attestation KYB valide dans le registre on-chain. Sans attestation valide, le dataset reste visible mais ne peut pas être emprunté.":
    "The badge means the dataset provider has a valid KYB attestation in the on-chain registry. Without a valid attestation, the dataset stays visible but cannot be borrowed.",
  "Comment récupérer mon modèle ?": "How do I get my model?",
  "Quand l’entraînement est réglé, clique sur Vérifier et télécharger sur la page Entraîner : la clé du modèle est livrée et tu peux le déchiffrer dans ton navigateur.":
    "Once training is settled, click Verify and download on the Train page: the model key is delivered and you can decrypt it in your browser.",
  "Que faire si l’entraînement échoue ?": "What if training fails?",
  "Le prix du dataset et le compute non utilisé sont remboursés dans l’escrow ; seuls les frais d’exécution mesurés, plafonnés dans le devis, sont retenus. Retire le crédit depuis la page Wallet.":
    "The dataset price and the unused compute are refunded into the escrow; only measured execution fees, capped in the quote, are retained. Withdraw the credit from the Wallet page.",
  "Quelles limites pour mon CSV ?": "What limits apply to my CSV?",
  "Un CSV de colonnes numériques, assez grand pour préserver la confidentialité : la taille, le nombre de lignes et de colonnes acceptés sont rappelés sur la page de publication.":
    "A CSV of numeric columns, large enough to preserve privacy: the accepted size, row and column counts are listed on the publishing page.",
  "Quand suis-je payé·e ?": "When do I get paid?",
  "À chaque entraînement réglé, ton gain est crédité dans l’escrow : retire-le depuis la page Wallet (tu paies le gas).":
    "On every settled training run, your earnings are credited in the escrow: withdraw them from the Wallet page (you pay the gas).",
  "Comment ajouter des fonds ?": "How do I add funds?",
  "Clique sur Ajouter des fonds : par carte, depuis un autre wallet ou depuis une autre chaîne sur mainnet ; un robinet de test sur le testnet.":
    "Click Add funds: by card, from another wallet or from another chain on mainnet; a test faucet on the testnet.",
  "Pourquoi me faut-il de l’ETH ?": "Why do I need ETH?",
  "Le gas (frais réseau) se paie toujours en ETH sur Robinhood Chain, séparément du stablecoin qui règle les emprunts.":
    "Gas (network fees) is always paid in ETH on Robinhood Chain, separately from the stablecoin that pays for loans.",
  "Comment retirer mes règlements ?": "How do I withdraw my settlements?",
  "Les règlements et remboursements sont crédités dans l’escrow : sur la page Wallet, clique sur Retirer pour les ramener dans ton wallet.":
    "Settlements and refunds are credited in the escrow: on the Wallet page, click Withdraw to move them to your wallet.",
  "Que montre l’Explorer ?": "What does the Explorer show?",
  "Tes emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne. Jamais le contenu des datasets.":
    "Your borrowings, settlements and refunds, each verifiable on the chain explorer. Never the contents of datasets.",
  "Qu’est-ce qu’un reçu d’audit ?": "What is an audit receipt?",
  "Chaque entraînement produit un reçu d’audit et un certificat qui lient le titre du dataset, le prêt, l’attestation TEE et l’empreinte du modèle livré.":
    "Every training run produces an audit receipt and a certificate binding the dataset title, the loan, the TEE attestation and the fingerprint of the delivered model.",
  "Pourquoi vérifier mon wallet ?": "Why verify my wallet?",
  "Chaque prêteur et chaque emprunteur est vérifié on-chain : ça protège les données et l’argent de tout le monde sur la marketplace.":
    "Every lender and borrower is verified on-chain: it protects everyone’s data and money on the marketplace.",
  "Comment obtenir l’accès instantané ?": "How do I get instant access?",
  "Quand il est ouvert, Sirius signe une attestation de 30 jours pour ton wallet : une seule transaction à confirmer, avec un peu d’ETH pour le gas.":
    "When it is open, Sirius signs a 30-day attestation for your wallet: a single transaction to confirm, with a little ETH for gas.",
  "Qu’est-ce qu’une attestation TEE ?": "What is a TEE attestation?",
  "La preuve, vérifiée à chaque requête, que le code qui entraîne tourne bien dans l’enclave attendue : son identité est épinglée et comparée.":
    "The proof, checked on every request, that the training code runs inside the expected enclave: its identity is pinned and compared.",
};
