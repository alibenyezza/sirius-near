/**
 * Traductions du bouton profil et de la page Wallet de lancement (slice A5).
 * Fichier séparé, fusionné dans `EN_MESSAGES`, pour que les autres slices qui complètent
 * `english.ts` ne se marchent pas dessus.
 */
export const PROFILE_MESSAGES_EN: Record<string, string> = {
  // Bouton profil
  "Menu du profil": "Profile menu",
  "Navigation": "Navigation",
  "Robinhood Chain mainnet": "Robinhood Chain mainnet",
  "Robinhood Chain testnet": "Robinhood Chain testnet",
  "Explorateur": "Explorer",
  "Copie impossible": "Copy failed",
  "Wallet": "Wallet",
  "Réglages": "Settings",
  "Vérification": "Verification",
  "Visite guidée": "Guided tour",
  "La visite guidée sera bientôt disponible.": "The guided tour will be available soon.",
  "Se déconnecter": "Log out",
  "USDG": "USDG",

  // Page Wallet : ajout de fonds
  "Utiliser le pont": "Use the bridge",
  "Ouverture du pont…": "Opening the bridge…",
  "Voir sur l’explorateur": "View on explorer",
  "Recevoir des {token} par transfert": "Receive {token} by transfer",
  "Envoie des {token} sur Robinhood Chain à l’adresse ci-dessous, depuis un autre wallet ou une plateforme d’échange qui supporte ce réseau. Les fonds arrivent dès que le transfert est confirmé.":
    "Send {token} on Robinhood Chain to the address below, from another wallet or an exchange that supports this network. Funds arrive as soon as the transfer is confirmed.",
  "QR code de ton adresse de wallet": "QR code of your wallet address",
  "Ton adresse": "Your address",
  "N’envoie que des {token}, sur Robinhood Chain. Un autre jeton ou un autre réseau peut être perdu définitivement.":
    "Only send {token}, on Robinhood Chain. Another token or another network may be lost permanently.",
  "Pour un premier transfert, envoie d’abord un petit montant et vérifie qu’il arrive.":
    "For a first transfer, send a small amount first and check that it arrives.",
  "Compare le début et la fin de l’adresse dans ton wallet avant de confirmer.":
    "Compare the beginning and the end of the address in your wallet before confirming.",
  "Les frais réseau se paient en ETH : garde un peu d’ETH sur la même adresse.":
    "Network fees are paid in ETH: keep a little ETH on the same address.",
  "Le bouton de pont ci-dessus ouvre un service tiers : vérifie qu’il supporte {token} avant de l’utiliser.":
    "The bridge button above opens a third-party service: check that it supports {token} before using it.",
};
