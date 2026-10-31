/**
 * Traductions de la fenêtre « Ajouter des fonds » sur mainnet (slice F2) : carte bancaire,
 * autre wallet, autre chaîne. Fichier séparé, fusionné dans `EN_MESSAGES`, pour que les
 * autres slices qui complètent `english.ts` ne se marchent pas dessus.
 */
export const FUNDING_MESSAGES_EN: Record<string, string> = {
  // Fenêtre et choix
  "Fermer": "Close",
  "Par carte bancaire": "By card",
  "Achète des USDG ou de l’ETH avec MoonPay.": "Buy USDG or ETH with MoonPay.",
  "Depuis un autre wallet": "From another wallet",
  "Envoie des USDG ou de l’ETH depuis l’app Robinhood, Kraken ou ton wallet.": "Send USDG or ETH from the Robinhood app, Kraken or your wallet.",
  "Depuis une autre chaîne": "From another chain",
  "Ton USDC sur Base arrive en USDG, ou en ETH pour le gas, sur Robinhood Chain.": "Your USDC on Base arrives as USDG, or as ETH for gas, on Robinhood Chain.",
  "Les fonds arrivent sur l’adresse de ton compte, sur Robinhood Chain. Le solde affiché est celui lu sur la chaîne : il change quand les fonds sont arrivés.":
    "Funds arrive at your account address, on Robinhood Chain. The balance shown is read from the chain: it changes once the funds have arrived.",
  "Autres moyens": "Other methods",
  "Chargement des options…": "Loading options…",

  // Autre wallet
  "N’envoie que de l’USDG ou de l’ETH, sur le réseau Robinhood Chain. Tout autre jeton, ou un autre réseau, et les fonds sont perdus définitivement.":
    "Only send USDG or ETH, on the Robinhood Chain network. Any other token, or any other network, and the funds are lost for good.",
  "Sources confirmées : l’app Robinhood et Kraken. Au moment du retrait, choisis le réseau « Robinhood Chain ».":
    "Confirmed sources: the Robinhood app and Kraken. When you withdraw, choose the “Robinhood Chain” network.",

  // Carte bancaire et pont
  "Le paiement se fait chez MoonPay, dans un nouvel onglet. MoonPay vérifie ton identité avant le premier achat.":
    "Payment happens on MoonPay, in a new tab. MoonPay verifies your identity before your first purchase.",
  "L’USDG arrive directement sur l’adresse de ton compte, sur Robinhood Chain.": "USDG arrives directly at your account address, on Robinhood Chain.",
  "Garde un peu d’ETH pour payer les frais réseau.": "Keep a little ETH to pay network fees.",
  "Le pont s’ouvre dans un nouvel onglet. Connecte-y le wallet qui détient tes fonds sur Base.":
    "The bridge opens in a new tab. Connect the wallet that holds your funds on Base.",
  "Tu paies en USDC sur Base. Tu reçois de l’USDG, ou de l’ETH pour le gas, sur l’adresse de ton compte, sur Robinhood Chain.":
    "You pay in USDC on Base. You receive USDG, or ETH for gas, at your account address, on Robinhood Chain.",
  "Vérifie l’adresse de destination sur le pont avant de confirmer.": "Check the destination address on the bridge before you confirm.",
  "Recevoir": "Receive",
  "ETH pour le gas": "ETH for gas",
  "Montant en USD": "Amount in USD",
  "Montant en USDC sur Base": "Amount in USDC on Base",
  "Minimum : {min} USD": "Minimum: {min} USD",
  "La page MoonPay s’est ouverte dans un nouvel onglet.": "The MoonPay page opened in a new tab.",
  "Le pont s’est ouvert dans un nouvel onglet.": "The bridge opened in a new tab.",
  "Rien ne s’est ouvert ? Ouvre la page ici.": "Nothing opened? Open the page here.",
  "Continuer vers MoonPay": "Continue to MoonPay",
  "Ouvrir le pont": "Open the bridge",

  // Erreurs du client
  "Indique un montant": "Enter an amount",
  "Montant trop élevé": "Amount too high",
  "Montant inférieur au minimum": "Amount below the minimum",
  "Service d’ajout de fonds injoignable": "Funding service unreachable",
  "Réponse du service d’ajout de fonds invalide": "Invalid response from the funding service",
};
