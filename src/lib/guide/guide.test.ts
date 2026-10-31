import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EN_MESSAGES, translateEnglish as t } from "../i18n/english";
import { guideCopyKeys, guideVerifyWhy, GUIDE_TOUR_COPY } from "./copy";
import {
  deriveGuidePhase,
  EMPTY_GUIDE_PROGRESS,
  GUIDE_NAME,
  GUIDE_TOUR_STOPS,
  guideAnchorSelector,
  guideVerifyMode,
  isEmptyGuideProgress,
  mergeGuideProgress,
  parseGuideProgress,
  parseProfileGuideProgress,
  readLocalGuideProgress,
  reduceGuideProgress,
  shouldOfferPageTour,
  writeLocalGuideProgress,
  type GuideProgress,
  type GuideStorage,
} from "./machine";
import { GUIDE_PAGE_KEYS, GUIDE_PAGE_TOURS, guidePageAnchor, guidePageCopyKeys, guidePageForPath, guidePageStepBody, resolveGuidePageStep, visibleGuidePageSteps } from "./pages";

const A = `0x${"ab".repeat(20)}`;
const base = { connected: false, authenticated: false, kyb: null, progress: { ...EMPTY_GUIDE_PROGRESS } } as const;

test("la phase suit l'état réel : accueil, connexion, signature, vérification, tour, puis bulle", () => {
  assert.equal(deriveGuidePhase({ ...base }), "arrival");
  const seen: GuideProgress = { ...EMPTY_GUIDE_PROGRESS, arrivalSeen: true };
  assert.equal(deriveGuidePhase({ ...base, progress: seen }), "connect");
  assert.equal(deriveGuidePhase({ ...base, progress: seen, connected: true }), "signin");
  assert.equal(deriveGuidePhase({ ...base, progress: seen, connected: true, authenticated: true, kyb: null }), "verify");
  assert.equal(deriveGuidePhase({ ...base, progress: seen, connected: true, authenticated: true, kyb: "missing" }), "verify");
  assert.equal(deriveGuidePhase({ ...base, progress: seen, connected: true, authenticated: true, kyb: "unknown" }), "verify");
  assert.equal(deriveGuidePhase({ ...base, progress: seen, connected: true, authenticated: true, kyb: "valid" }), "tour");
  assert.equal(deriveGuidePhase({ ...base, progress: { ...seen, tourDone: true }, connected: true, authenticated: true, kyb: "valid" }), "done");
  // Un wallet déjà vérifié saute les étapes faites ; une déconnexion ramène à la connexion.
  assert.equal(deriveGuidePhase({ ...base, progress: { ...seen, tourIndex: 3 }, connected: false }), "connect");
  // « Passer » range le guide, quel que soit l'état du compte.
  assert.equal(deriveGuidePhase({ ...base, progress: { ...EMPTY_GUIDE_PROGRESS, skipped: true } }), "done");
  assert.equal(deriveGuidePhase({ ...base, progress: { ...seen, skipped: true }, connected: true, authenticated: true, kyb: "valid" }), "done");
});

test("les actions font avancer la progression ; la relance repart de l'accueil", () => {
  let progress: GuideProgress = { ...EMPTY_GUIDE_PROGRESS };
  progress = reduceGuideProgress(progress, { type: "arrival-continue" });
  assert.equal(progress.arrivalSeen, true);
  for (let i = 0; i < GUIDE_TOUR_STOPS.length - 1; i += 1) progress = reduceGuideProgress(progress, { type: "tour-next" });
  assert.equal(progress.tourIndex, GUIDE_TOUR_STOPS.length - 1);
  assert.equal(progress.tourDone, false);
  progress = reduceGuideProgress(progress, { type: "tour-previous" });
  assert.equal(progress.tourIndex, GUIDE_TOUR_STOPS.length - 2);
  progress = reduceGuideProgress(progress, { type: "tour-next" });
  progress = reduceGuideProgress(progress, { type: "tour-next" });
  assert.equal(progress.tourDone, true);
  assert.equal(reduceGuideProgress({ ...EMPTY_GUIDE_PROGRESS }, { type: "tour-previous" }).tourIndex, 0);
  assert.equal(reduceGuideProgress({ ...EMPTY_GUIDE_PROGRESS }, { type: "tour-finish" }).tourDone, true);
  assert.equal(reduceGuideProgress({ ...EMPTY_GUIDE_PROGRESS }, { type: "skip" }).skipped, true);
  assert.deepEqual(reduceGuideProgress({ ...progress, skipped: true }, { type: "replay" }), EMPTY_GUIDE_PROGRESS);
  // Réduire est mémorisé ; reprendre, ou toute autre action, rouvre.
  const minimized = reduceGuideProgress({ ...EMPTY_GUIDE_PROGRESS, arrivalSeen: true, tourIndex: 2 }, { type: "minimize" });
  assert.deepEqual(minimized, { ...EMPTY_GUIDE_PROGRESS, arrivalSeen: true, tourIndex: 2, minimized: true });
  assert.equal(deriveGuidePhase({ ...base, progress: minimized, connected: true, authenticated: true, kyb: "valid" }), "tour", "la phase ne dépend pas de l'état réduit");
  assert.deepEqual(reduceGuideProgress(minimized, { type: "restore" }), { ...minimized, minimized: false });
  assert.equal(reduceGuideProgress(minimized, { type: "tour-next" }).minimized, false);
  assert.equal(reduceGuideProgress(minimized, { type: "skip" }).minimized, false);
});

test("la progression lue est bornée et fusionnée vers la plus avancée", () => {
  assert.deepEqual(parseGuideProgress(undefined), EMPTY_GUIDE_PROGRESS);
  assert.deepEqual(parseGuideProgress({ v: 2, arrivalSeen: true }), EMPTY_GUIDE_PROGRESS);
  assert.deepEqual(parseGuideProgress({ v: 1, arrivalSeen: "yes", tourIndex: 99, tourDone: 1, skipped: true }), {
    ...EMPTY_GUIDE_PROGRESS, tourIndex: GUIDE_TOUR_STOPS.length - 1, skipped: true,
  });
  assert.equal(parseGuideProgress({ v: 1, tourIndex: -4 }).tourIndex, 0);
  assert.equal(parseGuideProgress({ v: 1, tourIndex: 1.5 }).tourIndex, 0);
  assert.equal(parseGuideProgress({ v: 1, minimized: true }).minimized, true);
  assert.equal(parseGuideProgress({ v: 1 }).minimized, false);
  const merged = mergeGuideProgress({ ...EMPTY_GUIDE_PROGRESS, arrivalSeen: true, tourIndex: 2 }, { ...EMPTY_GUIDE_PROGRESS, tourIndex: 1, tourDone: true });
  assert.deepEqual(merged, { v: 1, arrivalSeen: true, tourIndex: 2, tourDone: true, skipped: false, minimized: false, pages: {} });
  assert.equal(isEmptyGuideProgress({ ...EMPTY_GUIDE_PROGRESS, minimized: true }), false);
  assert.equal(isEmptyGuideProgress(EMPTY_GUIDE_PROGRESS), true);
  assert.equal(isEmptyGuideProgress(merged), false);
  assert.deepEqual(parseProfileGuideProgress({ address: A.toUpperCase(), settings: { guide: { v: 1, skipped: true } } }, A), { ...EMPTY_GUIDE_PROGRESS, skipped: true });
  assert.equal(parseProfileGuideProgress({ address: `0x${"cd".repeat(20)}`, settings: { guide: { v: 1, skipped: true } } }, A), null);
  assert.equal(parseProfileGuideProgress({ address: A }, A), null);
  assert.deepEqual(parseProfileGuideProgress({ address: A, settings: {} }, A), EMPTY_GUIDE_PROGRESS);
});

test("le stockage local ne lève jamais : absent, interdit, plein ou corrompu", () => {
  class Memory implements GuideStorage {
    map = new Map<string, string>();
    failing = false;
    getItem(key: string) { if (this.failing) throw new Error("SecurityError"); return this.map.get(key) ?? null; }
    setItem(key: string, value: string) { if (this.failing) throw new Error("QuotaExceededError"); this.map.set(key, value); }
    removeItem(key: string) { if (this.failing) throw new Error("SecurityError"); this.map.delete(key); }
  }
  const storage = new Memory();
  assert.deepEqual(readLocalGuideProgress(null), EMPTY_GUIDE_PROGRESS);
  assert.deepEqual(readLocalGuideProgress(storage), EMPTY_GUIDE_PROGRESS);
  writeLocalGuideProgress(storage, { ...EMPTY_GUIDE_PROGRESS, arrivalSeen: true, tourIndex: 2 });
  assert.deepEqual(readLocalGuideProgress(storage), { ...EMPTY_GUIDE_PROGRESS, arrivalSeen: true, tourIndex: 2 });
  writeLocalGuideProgress(storage, { ...EMPTY_GUIDE_PROGRESS });
  assert.equal(storage.map.size, 0, "une progression vide est effacée");
  storage.map.set("sirius-guide:anonymous", "{not json");
  assert.deepEqual(readLocalGuideProgress(storage), EMPTY_GUIDE_PROGRESS);
  storage.failing = true;
  assert.deepEqual(readLocalGuideProgress(storage), EMPTY_GUIDE_PROGRESS);
  assert.doesNotThrow(() => writeLocalGuideProgress(storage, { ...EMPTY_GUIDE_PROGRESS, skipped: true }));
});

test("le mode de vérification dit pourquoi et quoi faire, sans jamais bloquer", () => {
  assert.equal(guideVerifyMode({ kyb: null, instantAccess: true, gasWei: "1" }), "loading");
  assert.equal(guideVerifyMode({ kyb: "unknown", instantAccess: true, gasWei: "1" }), "unknown");
  assert.equal(guideVerifyMode({ kyb: "missing", instantAccess: false, gasWei: "1" }), "invitation");
  assert.equal(guideVerifyMode({ kyb: "missing", instantAccess: true, gasWei: "0" }), "needs-gas");
  assert.equal(guideVerifyMode({ kyb: "missing", instantAccess: true, gasWei: "10" }), "instant");
  assert.equal(guideVerifyMode({ kyb: "missing", instantAccess: true, gasWei: null }), "instant", "solde illisible : on laisse essayer");
});

const root = fileURLToPath(new URL("../../", import.meta.url));

test("le profil accepte la progression du guide, bornée comme la machine, et refuse le reste", async () => {
  process.env.DATABASE_URL ??= "postgresql://synthetic:synthetic@127.0.0.1:1/unused";
  const profile = await import("../users/profile");
  const guide = { v: 1, arrivalSeen: true, tourIndex: GUIDE_TOUR_STOPS.length - 1, tourDone: false, skipped: false };
  assert.deepEqual(profile.validateProfilePatch({ settings: { guide } }), { settings: { guide } });
  assert.deepEqual(profile.sanitizeSettings({ guide, onboardingDismissed: true }), { guide, onboardingDismissed: true });
  const minimized = { ...guide, minimized: true };
  assert.deepEqual(profile.validateProfilePatch({ settings: { guide: minimized } }), { settings: { guide: minimized } });
  for (const bad of [
    { ...guide, tourIndex: GUIDE_TOUR_STOPS.length }, { ...guide, tourIndex: -1 }, { ...guide, v: 2 }, { ...guide, skipped: "yes" },
    { ...guide, minimized: "yes" }, { ...guide, extra: true }, "done", null,
  ]) {
    assert.throws(() => profile.validateProfilePatch({ settings: { guide: bad } }), /Réglages de profil invalides/, JSON.stringify(bad));
    assert.deepEqual(profile.sanitizeSettings({ guide: bad }), {});
  }
  // La progression lue par le navigateur accepte tout ce que le serveur a accepté, avec ou sans l'état réduit.
  assert.deepEqual(parseGuideProgress(profile.validateProfilePatch({ settings: { guide } }).settings?.guide), { ...guide, minimized: false, pages: {} });
  assert.deepEqual(parseGuideProgress(profile.validateProfilePatch({ settings: { guide: minimized } }).settings?.guide), { ...minimized, pages: {} });
});

test("les arrêts du tour existent dans la barre latérale, et les ancres sont des sélecteurs d'attribut", () => {
  const sidebar = readFileSync(`${root}components/layout/Sidebar.tsx`, "utf8");
  for (const stop of GUIDE_TOUR_STOPS) {
    assert.ok(sidebar.includes(`href: "${stop.href}"`), `${stop.href} absent de la barre latérale`);
    assert.ok(GUIDE_TOUR_COPY[stop.key], stop.key);
  }
  assert.equal(guideAnchorSelector("sign-in"), '[data-guide="sign-in"]');
  assert.equal(guideAnchorSelector("nav:/train"), '[data-guide="nav:/train"]');
  assert.equal(GUIDE_NAME, "Sirio");
});

// ─── Visites de page ──────────────────────────────────────────────────────────────────────────

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return ["generated", "abi", "i18n"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.tsx$/.test(entry.name) ? [path] : [];
  });
}

test("chaque page de l'application a sa visite, et chaque arrêt vise une ancre posée dans l'interface", () => {
  assert.deepEqual(
    ["/dashboard", "/train", "/phala", "/marketplace", "/marketplace/abc-123", "/datasets", "/datasets/new", "/explorer", "/wallet", "/kyb", "/kyb/"].map(guidePageForPath),
    ["dashboard", "train", "phala", "marketplace", "dataset", "datasets", "upload", "explorer", "wallet", "kyb", "kyb"],
  );
  for (const path of ["/", "/docs", "/datasets/abc", "/marketplace/a/b", "/settings", "marketplace", null, undefined, "/".padEnd(300, "a")]) {
    assert.equal(guidePageForPath(path), null, String(path));
  }
  const sources = [...sourceFiles(`${root}app`), ...sourceFiles(`${root}components`)].map((file) => readFileSync(file, "utf8")).join("\n");
  for (const page of GUIDE_PAGE_KEYS) {
    const tour = GUIDE_PAGE_TOURS[page];
    assert.ok(tour.steps.length >= 3, `${page} : au moins une présentation et deux arrêts`);
    assert.equal(tour.steps[0].anchor, null, `${page} : le premier arrêt présente la page`);
    for (const step of tour.steps) {
      if (step.anchor === null) continue;
      assert.match(step.anchor, /^[a-z][a-z-]*$/, `${page}:${step.anchor}`);
      const attribute = `"${guidePageAnchor(page, step.anchor)}"`;
      assert.ok(sources.includes(attribute), `ancre ${attribute} absente de l'interface`);
    }
    const anchors = tour.steps.flatMap((step) => (step.anchor ? [step.anchor] : []));
    assert.equal(new Set(anchors).size, anchors.length, `${page} : ancres uniques`);
  }
  assert.equal(guideAnchorSelector(guidePageAnchor("wallet", "balance")), '[data-guide="page:wallet:balance"]');
  // Seuls les arrêts dont l'ancre est à l'écran sont proposés ; la présentation reste toujours.
  const shown = visibleGuidePageSteps("dashboard", new Set(["balance", "shortcuts"]));
  assert.deepEqual(shown.map((step) => step.anchor), [null, "balance", "shortcuts"]);
  assert.deepEqual(visibleGuidePageSteps("kyb", new Set()).map((step) => step.anchor), [null]);
  // Arrêt retrouvé par son ancre : une ancre qui apparaît avant lui ne le décale pas.
  const before = resolveGuidePageStep("dashboard", new Set(["balance", "shortcuts"]), "balance");
  assert.equal(before.steps[before.index].anchor, "balance");
  const after = resolveGuidePageStep("dashboard", new Set(["get-started", "balance", "shortcuts"]), "balance");
  assert.equal(after.steps[after.index].anchor, "balance");
  assert.equal(after.index, 2);
  // Ancre disparue : l'arrêt visible suivant de la visite, sinon le dernier.
  const gone = resolveGuidePageStep("dashboard", new Set(["get-started", "shortcuts"]), "balance");
  assert.equal(gone.steps[gone.index].anchor, "shortcuts");
  const tail = resolveGuidePageStep("dashboard", new Set(["get-started"]), "shortcuts");
  assert.equal(tail.steps[tail.index].anchor, "get-started");
  assert.equal(resolveGuidePageStep("dashboard", new Set(), null).index, 0);
  // Texte selon le réseau : le mot « mainnet » n'apparaît que sur mainnet.
  const kyb = GUIDE_PAGE_TOURS.kyb.steps[0];
  assert.match(guidePageStepBody(kyb, "mainnet"), /mainnet/);
  assert.doesNotMatch(guidePageStepBody(kyb, "testnet"), /mainnet/);
  assert.equal(guidePageStepBody(GUIDE_PAGE_TOURS.marketplace.steps[1], "mainnet"), GUIDE_PAGE_TOURS.marketplace.steps[1].body);
});

test("les visites de page ne s'ouvrent qu'après l'accueil, une fois chacune, et leur état « vu » est mémorisé et fusionné", () => {
  const fresh = { ...EMPTY_GUIDE_PROGRESS };
  assert.equal(shouldOfferPageTour(fresh, "wallet"), false, "accueil pas encore passé");
  assert.equal(shouldOfferPageTour({ ...fresh, arrivalSeen: true, tourIndex: 3 }, "wallet"), false, "tour du menu en cours");
  const skipped = { ...fresh, skipped: true };
  assert.equal(shouldOfferPageTour(skipped, "wallet"), true);
  assert.equal(shouldOfferPageTour({ ...fresh, tourDone: true }, "wallet"), true);
  assert.equal(shouldOfferPageTour(skipped, null), false);
  const seen = reduceGuideProgress(skipped, { type: "page-seen", page: "wallet" });
  assert.deepEqual(seen.pages, { wallet: true });
  assert.equal(shouldOfferPageTour(seen, "wallet"), false);
  assert.equal(shouldOfferPageTour(seen, "train"), true);
  assert.equal(seen.skipped, true, "la visite de page ne touche pas au parcours principal");
  // Relance du guide : les pages vues le restent (pas de cascade de visites après l'accueil).
  assert.deepEqual(reduceGuideProgress(seen, { type: "replay" }), { ...EMPTY_GUIDE_PROGRESS, pages: { wallet: true } });
  assert.equal(isEmptyGuideProgress({ ...EMPTY_GUIDE_PROGRESS, pages: { wallet: true } }), false);
  // Lecture tolérante : clés inconnues ou valeurs fausses ignorées ; fusion par union.
  assert.deepEqual(parseGuideProgress({ v: 1, skipped: true, pages: { wallet: true, train: false, bogus: true, kyb: "yes" } }).pages, { wallet: true });
  assert.deepEqual(parseGuideProgress({ v: 1, pages: "wallet" }).pages, {});
  assert.deepEqual(mergeGuideProgress({ ...skipped, pages: { wallet: true } }, { ...fresh, pages: { train: true } }).pages, { wallet: true, train: true });
  assert.deepEqual(guidePageCopyKeys().filter((key) => !Object.hasOwn(EN_MESSAGES, key)), []);
  for (const key of guidePageCopyKeys()) {
    if (key.includes("mainnet")) continue;
    assert.doesNotMatch(t(key), /mainnet/i, key);
  }
});

test("le profil accepte les pages vues du guide, bornées aux pages connues, et refuse le reste", async () => {
  process.env.DATABASE_URL ??= "postgresql://synthetic:synthetic@127.0.0.1:1/unused";
  const profile = await import("../users/profile");
  const guide = { v: 1, arrivalSeen: true, tourIndex: 0, tourDone: false, skipped: true, pages: { wallet: true, dataset: true } };
  assert.deepEqual(profile.validateProfilePatch({ settings: { guide } }), { settings: { guide } });
  assert.deepEqual(profile.sanitizeSettings({ guide }), { guide });
  const none = { ...guide, pages: {} };
  assert.deepEqual(profile.validateProfilePatch({ settings: { guide: none } }), { settings: { guide: none } });
  for (const bad of [{ ...guide, pages: { bogus: true } }, { ...guide, pages: { wallet: false } }, { ...guide, pages: ["wallet"] }, { ...guide, pages: "wallet" }]) {
    assert.throws(() => profile.validateProfilePatch({ settings: { guide: bad } }), /Réglages de profil invalides/, JSON.stringify(bad));
    assert.deepEqual(profile.sanitizeSettings({ guide: bad }), {});
  }
  assert.deepEqual(parseGuideProgress(profile.validateProfilePatch({ settings: { guide } }).settings?.guide).pages, { wallet: true, dataset: true });
});

test("chaque texte du guide a une traduction anglaise, sans « mainnet » sur le testnet", () => {
  const missing = guideCopyKeys().filter((key) => !Object.hasOwn(EN_MESSAGES, key));
  assert.deepEqual(missing, []);
  assert.match(guideVerifyWhy("mainnet"), /mainnet/);
  assert.doesNotMatch(guideVerifyWhy("testnet"), /mainnet/);
  for (const key of guideCopyKeys()) {
    if (key.includes("mainnet")) continue;
    assert.doesNotMatch(t(key), /mainnet/i, key);
  }
  assert.equal(t("Salut, je suis {name}.", { name: GUIDE_NAME }), "Hi, I’m Sirio.");
});
