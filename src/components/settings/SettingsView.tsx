"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { replayGuide } from "@/components/guide/guide-store";
import { Card } from "@/components/ui/Card";
import { ConnectPrompt } from "@/components/wallet/ConnectCta";
import { Page, PageHeader } from "@/components/layout/Page";
import { SectionTitle } from "@/components/ui/Heading";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { useWalletStore } from "@/stores/wallet";
import { SoonItem } from "./SoonItem";
import { LANGUAGE_CHOICES, networkInfo, savedLanguage, SETTINGS_SOON, type LanguageChoice } from "./settings-logic";

const NETWORK = resolveClientNetwork();

type SaveState = "idle" | "saving" | "saved" | "failed";

/** Page /settings : réseau (lecture seule), langue, visite guidée et réglages à venir. */
export function SettingsView() {
  const { t } = useLocale();
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const network = networkInfo(NETWORK);

  return (
    <Page width="wide">
      <PageHeader title={t("Réglages")} />

      {!connected && (
        <ConnectPrompt message={t("Connecte un wallet pour enregistrer tes réglages.")} data-testid="settings-signed-out" />
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <section aria-labelledby="settings-network" className="flex">
          <Card className="flex-1">
            <SectionTitle id="settings-network">{t("Network")}</SectionTitle>
            <p className="mt-2 text-sm font-medium" data-testid="settings-network">{t(network.label)}</p>
            <p className="mt-1 text-xs text-muted">{t("Each Sirius site is tied to a single network. It cannot be changed here.")}</p>
            {network.testnetUrl && (
              <a
                href={network.testnetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline"
              >
                {t("Try it on testnet")}
              </a>
            )}
          </Card>
        </section>

        {connected && address && (
          <LanguageCard key={address} authenticated={authenticated} />
        )}

        <section aria-labelledby="settings-tour" className="flex">
          <Card className="flex-1">
            <SectionTitle id="settings-tour">{t("Visite guidée")}</SectionTitle>
            <p className="mt-2 text-xs text-muted">{t("Replay the welcome tour of the application.")}</p>
            <button
              type="button"
              onClick={() => replayGuide()}
              className="mt-3 rounded-lg border border-border px-3.5 py-2 text-sm font-medium transition-colors hover:border-white/20"
            >
              {t("Restart guided tour")}
            </button>
          </Card>
        </section>
      </div>

      <section aria-labelledby="settings-soon">
        <SectionTitle id="settings-soon" className="mb-3">{t("Coming soon")}</SectionTitle>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {SETTINGS_SOON.map((item) => <SoonItem key={item.title} {...item} />)}
        </ul>
      </section>
    </Page>
  );
}

/** Langue du profil. Lue et enregistrée par `/api/profile` ; sans session, rien n'est écrit. */
function LanguageCard({ authenticated }: { authenticated: boolean }) {
  const { t } = useLocale();
  const [saved, setSaved] = useState<LanguageChoice | null>(null);
  const [choice, setChoice] = useState<LanguageChoice>(LANGUAGE_CHOICES[0]);
  const [state, setState] = useState<SaveState>("idle");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void fetch("/api/profile", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          if (!cancelled) setLoadFailed(true);
          return;
        }
        const language = savedLanguage(await response.json());
        if (cancelled) return;
        setSaved(language);
        if (language) setChoice(language);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  async function save() {
    if (!authenticated || state === "saving") return;
    setState("saving");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { language: choice } }),
      });
      if (!response.ok) {
        setState("failed");
        return;
      }
      setSaved(savedLanguage(await response.json()) ?? choice);
      setState("saved");
    } catch {
      setState("failed");
    }
  }

  return (
    <section aria-labelledby="settings-language" className="flex">
      <Card className="flex-1">
        <SectionTitle id="settings-language">{t("Language")}</SectionTitle>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            aria-labelledby="settings-language"
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value as LanguageChoice);
              setState("idle");
            }}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="en">English</option>
          </select>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!authenticated || state === "saving" || saved === choice}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-background disabled:opacity-40"
          >
            {state === "saving" ? t("Saving…") : t("Save")}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">{t("English is the only language for now. French will come later.")}</p>
        {!authenticated && <p className="mt-2 text-xs text-muted">{t("Sign in with your wallet to save this setting.")}</p>}
        {state === "saved" && <p role="status" className="mt-2 text-xs text-positive">{t("Language saved.")}</p>}
        {state === "failed" && <p role="alert" className="mt-2 text-xs text-negative">{t("Could not save your settings. Try again.")}</p>}
        {loadFailed && state === "idle" && <p className="mt-2 text-xs text-muted">{t("Could not load your settings.")}</p>}
      </Card>
    </section>
  );
}
