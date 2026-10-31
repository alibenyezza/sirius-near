/**
 * Traductions du parcours d'accueil : carte « Get started » du tableau de bord, fenêtre de
 * vérification du wallet et indicateur des emprunts en cours. Fichier séparé, fusionné dans
 * `EN_MESSAGES`. `{token}` est le jeton de règlement du réseau (USDG sur mainnet), jamais écrit en dur.
 */
export const ONBOARDING_MESSAGES_EN: Record<string, string> = {
  // Carte « Get started »
  "Bien démarrer": "Get started",
  "{done} étapes sur {total} — de ton wallet à ton premier modèle entraîné.": "{done} of {total} steps — from your wallet to your first trained model.",
  "Tout est fait : tu as vérifié ton wallet, emprunté un dataset et récupéré un modèle.": "All done: you verified your wallet, borrowed a dataset and got a model.",
  "Masquer": "Hide",
  "Progression": "Progress",
  "fait": "done",
  "Loue des datasets privés pour entraîner tes modèles sans jamais exposer les données ; leurs fournisseurs sont payés à chaque entraînement.":
    "Rent private datasets to train your models without ever exposing the data; their providers get paid on every training run.",
  "Connecte ton wallet": "Connect your wallet",
  "Ton wallet est ton compte Sirius : pas d’e-mail ni de mot de passe.": "Your wallet is your Sirius account: no email, no password.",
  "Connecte-toi": "Sign in",
  "Signe un message dans ton wallet : c’est gratuit, ce n’est pas une transaction, et ça prouve que ce wallet est bien à toi.":
    "Sign a message in your wallet: it’s free, it’s not a transaction, and it proves you own this wallet.",
  "Vérifie ton wallet": "Verify your wallet",
  "Obligatoire pour prêter et emprunter sur mainnet. Une seule transaction à confirmer.": "Required to lend and borrow on mainnet. One transaction to confirm.",
  "Obligatoire pour prêter et emprunter. Une seule transaction à confirmer.": "Required to lend and borrow. One transaction to confirm.",
  "Avant de prêter ou d’emprunter un dataset, ton wallet doit être vérifié. Ça prend une seule transaction.":
    "Before you lend or borrow a dataset, your wallet must be verified. It takes a single transaction.",
  "Ajoute de l’ETH et des {token}": "Add ETH and {token}",
  "L’ETH paie le gas de chaque transaction ; les {token} paient l’emprunt.": "ETH pays the gas for each transaction; {token} pays for the loan.",
  "Choisis un dataset": "Pick a dataset",
  "Parcours la marketplace et ouvre la fiche d’un dataset.": "Browse the marketplace and open a dataset page.",
  "Emprunte-le": "Borrow it",
  "Sur la fiche, clique sur Emprunter : le prix du dataset et le compute sont bloqués en escrow.": "On the dataset page, click Borrow: the dataset price and compute are locked in escrow.",
  "Récupère ton modèle": "Get your model",
  "L’entraînement tourne dans une enclave TEE ; ton modèle t’attend sur la page Entraîner.": "Training runs in a TEE enclave; your model waits for you on the Train page.",
  "Voir mon statut de vérification": "Check my verification status",
  "Saisir un code d’invitation": "Enter an invitation code",
  "Ouvrir la marketplace": "Open the marketplace",
  "Ouvrir Entraîner": "Open Train",
  "Il te manque : {items}.": "Still missing: {items}.",
  "de l’ETH pour le gas": "ETH for gas",
  "des {token} pour emprunter": "{token} to borrow",
  " et ": " and ",

  // Fenêtre de vérification
  "Vérification · une transaction": "Verification · one transaction",
  "Ton wallet est vérifié": "Your wallet is verified",
  "Avant de prêter ou d’emprunter un dataset sur mainnet, ton wallet doit être vérifié. Ça prend une seule transaction.":
    "Before you lend or borrow a dataset on mainnet, your wallet must be verified. It takes a single transaction.",
  "Pour emprunter ce dataset, ton wallet doit d’abord être vérifié. Une fois fait, l’emprunt reprend tout seul.":
    "To borrow this dataset, your wallet must first be verified. Once done, the loan continues on its own.",
  "Pour publier un dataset, ton wallet doit d’abord être vérifié. Une fois fait, la publication reprend toute seule.":
    "To publish a dataset, your wallet must first be verified. Once done, publishing continues on its own.",
  "Sirius signe une attestation de 30 jours pour ce wallet ; tu la confirmes dans ton wallet. La transaction coûte un peu d’ETH de gas.":
    "Sirius signs a 30-day attestation for this wallet; you confirm it in your wallet. The transaction costs a little ETH for gas.",
  "Ton wallet n’a pas encore d’ETH sur Robinhood Chain. Il en faut un peu pour payer le gas de la transaction : ajoute-en d’abord, puis reviens ici.":
    "Your wallet has no ETH on Robinhood Chain yet. You need a little to pay the transaction gas: add some first, then come back here.",
  "L’accès instantané n’est pas ouvert en ce moment. Colle le code d’invitation reçu de l’équipe Sirius, ou écris-nous pour en obtenir un.":
    "Instant access is not open right now. Paste the invitation code you received from the Sirius team, or write to us to get one.",
  "Vérification de ton wallet…": "Checking your wallet…",
  "Pas d’invitation ? Écris-nous :": "No invitation? Write to us:",
  "Plus tard": "Not now",
  "J’ai ajouté de l’ETH": "I added ETH",
  "Ajouter de l’ETH": "Add ETH",
  "Tu peux maintenant prêter et emprunter des datasets. Prochaine étape : ajouter des fonds, puis choisir un dataset.":
    "You can now lend and borrow datasets. Next step: add funds, then pick a dataset.",
  "Continuer": "Continue",
  "Attestation de démonstration": "Demo attestation",

  // Indicateur des emprunts en cours
  "1 emprunt :": "1 loan:",
  "{count} emprunts :": "{count} loans:",
  "paiement en cours de finalisation": "payment finalizing",
  "fonds en escrow · lance l’entraînement": "funds in escrow — start training",
  "entraînement en cours": "training",
  "livraison du modèle": "delivering model",
  "action requise sur Train": "action needed on Train",
};
