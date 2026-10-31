/**
 * Traductions des pages Réglages et KYB (slice A6). Fichier séparé, fusionné dans
 * `EN_MESSAGES`, pour que les autres slices qui complètent `english.ts` ne se marchent pas dessus.
 * Les textes de ces pages sont écrits directement en anglais : la clé et la valeur sont identiques.
 */
const IDENTICAL = [
  "Attestation valid until {date} (UTC).",
  "Wallet verification, recorded on-chain. Sirius sets it up automatically when you sign in.",
  "Checking your verification status…",
  "Coming soon",
  "Could not load your settings.",
  "Could not save your settings. Try again.",
  "Each Sirius site is tied to a single network. It cannot be changed here.",
  "English is the only language for now. French will come later.",
  "Invitation",
  "Language saved.",
  "Language",
  "Network",
  "No invitation? Write to us:",
  "Not verified",
  "Replay the welcome tour of the application.",
  "Restart guided tour",
  "Retry",
  "Save",
  "Saving…",
  "Sign in with your wallet to accept an invitation.",
  "Sign in with your wallet to save this setting.",
  "Soon",
  "Status unavailable",
  "Status",
  "The status is read from the verification registry contract.",
  "Try it on testnet",
  "Verified",
  "We could not read your verification status. This does not mean you are not verified.",
  "Your attestation expired on {date} (UTC). Ask for a new invitation.",
  "Your attestation has expired. Ask for a new invitation.",
  "Your attestation is no longer accepted by the registry. Ask for a new invitation.",
  "Your attestation was revoked. Contact the Sirius team.",
  // Éléments « Soon » (titres et descriptions)
  "Notifications",
  "Email alerts when your dataset is borrowed, a training finishes or a payment arrives.",
  "Display preferences",
  "Density and appearance options.",
  "Collapse the menu by default",
  "Start with the sidebar collapsed.",
  "Online verification without an invitation",
  "Submit your company details and be verified by a Sirius verifier.",
  "Benefits of verification",
  "Verified provider badge, higher lending limits and early access to new models.",
] as const;

export const SETTINGS_MESSAGES_EN: Record<string, string> = {
  ...Object.fromEntries(IDENTICAL.map((text) => [text, text])),
  "Connecte un wallet pour enregistrer tes réglages.": "Connect a wallet to save your settings.",
  "Connecte un wallet pour voir ton statut de vérification.": "Connect a wallet to see your verification status.",
  "Statut de vérification indisponible": "Verification status unavailable",
};
