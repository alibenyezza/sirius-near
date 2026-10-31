"use client";

import { useCallback, useEffect, useState } from "react";
import { EscrowCredits } from "@/components/wallet/EscrowCredits";
import { Card } from "@/components/ui/Card";
import { ConnectPrompt } from "@/components/wallet/ConnectCta";
import { Page, PageHeader } from "@/components/layout/Page";
import { SecureAccountCard } from "@/components/wallet/SecureAccount";
import { AddFundsDialog } from "@/components/wallet/AddFundsDialog";
import { addFundsOptions } from "@/components/wallet/add-funds";
import { normalizeAddress, shortAddress } from "@/components/profile/address";
import { isWrongNetwork, networkBadge } from "@/components/profile/network";
import { useCopy } from "@/components/profile/useCopy";
import { SignInCta } from "@/components/wallet/SignInCta";
import { SectionTitle } from "@/components/ui/Heading";
import { useWalletStore } from "@/stores/wallet";
import { fetchGasBalance, fetchUsdcBalance, type GasBalance, type UsdcBalance } from "@/lib/evm/balance";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { stablecoinSymbol } from "@/lib/evm/stablecoin";
import { addFunds } from "@/lib/wallet/onramp";
import { addressExplorerUrl } from "@/lib/evm/explorer";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { truncate } from "@/lib/format";
import { useLocale } from "@/components/i18n/LocaleProvider";

const NETWORK = resolveClientNetwork();

export default function WalletPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <WalletPageContent key={identity} />;
}

function WalletPageContent() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const starterFunds = useWalletStore((s) => s.starterFunds);
  const { locale, t } = useLocale();
  // « USDG » sur mainnet, « test USDC » traduit sur testnet.
  const token = NETWORK === "mainnet" ? stablecoinSymbol(NETWORK) : t("test USDC");
  // Testnet : le faucet, inchangé. Mainnet : le bouton ouvre la fenêtre « Ajouter des fonds »
  // (carte, autre wallet, autre chaîne), qui lit elle-même les options du serveur.
  const fundsOptions = addFundsOptions(NETWORK);
  const [fundsDialog, setFundsDialog] = useState(false);
  const checksummed = normalizeAddress(address);

  const [balance, setBalance] = useState<UsdcBalance | null>(null);
  const [gas, setGas] = useState<GasBalance | null>(null);
  const [balError, setBalError] = useState(false);

  const [fundsPending, setFundsPending] = useState(false);
  const [fundsMessage, setFundsMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setBalError(false);
    try {
      const [usdc, natif] = await Promise.all([
        fetchUsdcBalance(address),
        fetchGasBalance(address).catch(() => null),
      ]);
      setBalance(usdc);
      setGas(natif);
    } catch {
      setBalError(true);
    }
  }, [address]);

  const handleAddFunds = async () => {
    setFundsPending(true);
    setFundsMessage(null);
    try {
      const recu = await addFunds();
      setFundsMessage(
        recu.eth
          ? t("{usdc} {token} et {eth} ETH envoyés.", { usdc: recu.usdc, token, eth: recu.eth })
          : t("{usdc} {token} envoyés.", { usdc: recu.usdc, token }),
      );
      await refresh();
      // Sans cet effacement, la confirmation restait à l'écran indéfiniment. Le solde
      // continuait de bouger — un emprunt, un retrait — et « 1000 USDC envoyés » finissait
      // affiché à côté d'un solde qui ne correspondait plus, ce qui se lit comme un échec
      // du virement alors qu'il a bien eu lieu.
      window.setTimeout(() => setFundsMessage(null), 8_000);
    } catch (err) {
      setFundsMessage(t(err instanceof Error ? err.message : "Ajout de fonds indisponible"));
    } finally {
      setFundsPending(false);
    }
  };

  useEffect(() => {
    // `authenticated` en dépendance, et pas seulement l'adresse : la première signature
    // déclenche l'attestation KYB puis, sur un compte neuf, l'approvisionnement. Les deux
    // arrivent après ce premier affichage, et sans cette relecture l'utilisateur resterait
    // devant un solde nul alors que les fonds sont déjà sur la chaîne.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    refresh();
  }, [refresh, authenticated]);

  if (!connected || !address) {
    return (
      <Page width="wide">
        <PageHeader title={t("Wallet")} />
        <ConnectPrompt message={t("Connecte un wallet pour voir ton solde.")} />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader title={t("Wallet")} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-wrap items-end justify-between gap-4 lg:col-span-2" data-guide="page:wallet:balance">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted">{t("Solde")}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight">
                {balError ? "—" : balance ? Number(formatUsdcAtomic(balance.atomic)).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 6 }) : "…"}
              </span>
              <span className="text-sm text-muted">{token}</span>
            </div>
            {gas && (
              <p className={`mt-1.5 text-xs ${gas.low ? "text-negative" : "text-muted"}`}>
                {gas.low ? t("{eth} ETH — plus assez pour payer le gas", { eth: gas.eth }) : t("{eth} ETH pour le gas", { eth: gas.eth })}
              </p>
            )}
            {balError && <p className="mt-2 text-xs text-negative">{t("Solde indisponible.")}</p>}
          </div>
          <div className="flex flex-col items-end gap-2">
            {fundsOptions.faucet ? (
              <button
                onClick={handleAddFunds}
                disabled={fundsPending}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
              >
                {fundsPending ? t("Envoi en cours…") : t("Ajouter des fonds")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setFundsDialog(true)}
                aria-haspopup="dialog"
                className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90"
              >
                {t("Ajouter des fonds")}
              </button>
            )}
            {fundsMessage && <p className="max-w-[16rem] text-right text-xs text-muted">{fundsMessage}</p>}
            {!fundsMessage && fundsOptions.faucet && typeof starterFunds === "object" && (
              <p className="max-w-[16rem] text-right text-xs text-negative">
                {t("Fonds de démarrage non reçus : {reason}", { reason: t(starterFunds.failed) })}
              </p>
            )}
          </div>
        </Card>

        {checksummed && <AccountCard address={checksummed} authenticated={authenticated} />}
      </div>

      {fundsDialog && <AddFundsDialog network={NETWORK} address={address} onClose={() => setFundsDialog(false)} />}

      <EscrowCredits onWithdraw={refresh} guideAnchor="page:wallet:credits" />

      <SecureAccountCard />
    </Page>
  );
}

/** Compte connecté : réseau du site, adresse copiable et état de la session signée. */
function AccountCard({ address, authenticated }: { address: string; authenticated: boolean }) {
  const { t } = useLocale();
  const walletNetwork = useWalletStore((s) => s.network);
  const { state: copyState, copy } = useCopy();
  const badge = networkBadge(NETWORK);
  const wrongNetwork = isWrongNetwork(NETWORK, walletNetwork);
  return (
    <Card className="flex flex-col gap-4" data-guide="page:wallet:account">
      <div>
        <SectionTitle>{t("Network")}</SectionTitle>
        <p className="mt-2 flex items-center gap-2 text-sm font-medium">
          <span className={`h-2 w-2 rounded-full ${wrongNetwork ? "bg-negative" : "bg-positive"}`} aria-hidden />
          {t(badge.label)}
        </p>
        {wrongNetwork && (
          <p role="alert" className="mt-1 text-xs text-negative">
            {t("Mauvais réseau — bascule ton wallet sur {network}.", { network: NETWORK })}
          </p>
        )}
      </div>
      <div>
        <SectionTitle>{t("Wallet")}</SectionTitle>
        <p className="mt-2 font-mono text-sm" title={address}>{shortAddress(address) ?? truncate(address)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void copy(address)}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:border-white/20"
          >
            {copyState === "copied" ? t("Adresse copiée") : copyState === "failed" ? t("Copie impossible") : t("Copier l’adresse")}
          </button>
          <a
            href={addressExplorerUrl(NETWORK, address)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:border-white/20"
          >
            {t("Voir sur l’explorateur")}
          </a>
        </div>
      </div>
      <div>
        <SectionTitle>{t("Status")}</SectionTitle>
        {authenticated ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-positive">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" aria-hidden />
            {t("Authentifié")}
          </p>
        ) : (
          <div className="mt-2">
            <SignInCta>{t("Se connecter")}</SignInCta>
          </div>
        )}
      </div>
    </Card>
  );
}
