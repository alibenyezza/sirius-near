import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES, translateEnglish as t } from "@/lib/i18n/english";
import { STATUS_DOT_CLASS, STATUS_KINDS, STATUS_META, UNKNOWN_STATUS_META, isStatusKind, statusMeta } from "./status";
import { safeInternalHref } from "./safe-href";

const VARIANTS = ["default", "accent", "positive", "negative", "muted", "warning"];

test("les huit états du cahier des charges existent, chacun avec libellé et couleur", () => {
  assert.deepEqual(
    [...STATUS_KINDS],
    ["online", "borrowed", "paused", "expired", "destroyed", "pending", "failed", "refunded"],
  );
  for (const kind of STATUS_KINDS) {
    const meta = statusMeta(kind);
    assert.equal(meta, STATUS_META[kind]);
    assert.ok(VARIANTS.includes(meta.variant), kind);
    assert.ok(STATUS_DOT_CLASS[meta.variant], kind);
  }
});

test("libellés anglais attendus pour chaque état", () => {
  const expected = {
    online: "Online", borrowed: "Borrowed", paused: "Paused", expired: "Expired",
    destroyed: "Destroyed", pending: "Pending", failed: "Failed", refunded: "Refunded",
  } as const;
  for (const kind of STATUS_KINDS) assert.equal(t(STATUS_META[kind].labelKey), expected[kind], kind);
  assert.equal(t(UNKNOWN_STATUS_META.labelKey), "Unknown status");
});

test("les libellés sont tous traduits et distincts entre eux", () => {
  const keys = [...STATUS_KINDS.map((kind) => STATUS_META[kind].labelKey), UNKNOWN_STATUS_META.labelKey];
  for (const key of keys) {
    assert.ok(Object.hasOwn(EN_MESSAGES, key), key);
    assert.notEqual(EN_MESSAGES[key], key);
  }
  assert.equal(new Set(keys.map((key) => EN_MESSAGES[key])).size, keys.length);
});

test("table complète attendue : libellé français et variante de chaque état", () => {
  assert.deepEqual(STATUS_META, {
    online: { labelKey: "En ligne", variant: "positive" },
    borrowed: { labelKey: "Emprunté", variant: "accent" },
    paused: { labelKey: "En pause", variant: "warning" },
    expired: { labelKey: "Expiré", variant: "muted" },
    destroyed: { labelKey: "Détruit", variant: "negative" },
    pending: { labelKey: "En attente", variant: "warning" },
    failed: { labelKey: "Échoué", variant: "negative" },
    refunded: { labelKey: "Remboursé", variant: "default" },
  });
  assert.deepEqual(STATUS_DOT_CLASS, {
    default: "bg-foreground/60", accent: "bg-accent", positive: "bg-positive",
    negative: "bg-negative", muted: "bg-muted", warning: "bg-yellow-400",
  });
});

test("états qui doivent se distinguer d'un coup d'œil : en ligne, détruit, échoué", () => {
  assert.equal(STATUS_META.online.variant, "positive");
  assert.equal(STATUS_META.destroyed.variant, "negative");
  assert.equal(STATUS_META.failed.variant, "negative");
  assert.notEqual(STATUS_META.online.variant, STATUS_META.paused.variant);
  assert.notEqual(STATUS_META.online.variant, STATUS_META.expired.variant);
});

test("une valeur inattendue de l'API donne un repli neutre, jamais une exception", () => {
  for (const value of ["LISTED", "", "constructor", "__proto__", "toString", "hasOwnProperty", null, undefined, 5, {}, []]) {
    assert.equal(isStatusKind(value), false, String(value));
    assert.equal(statusMeta(value), UNKNOWN_STATUS_META, String(value));
  }
  assert.equal(UNKNOWN_STATUS_META.variant, "muted");
});

test("liens internes : seuls les chemins du site sont acceptés", () => {
  for (const ok of ["/", "/datasets/abc", "/datasets/new", "/marketplace?category=finance", "/a/b#c", "/%2F%2Fevil"]) {
    assert.equal(safeInternalHref(ok), ok, ok);
  }
  const refused = [
    "", "datasets/abc", "//evil.example", "/\\evil.example", "https://evil.example", "http://x", "javascript:alert(1)",
    "JaVaScRiPt:alert(1)", "data:text/html,x", "mailto:a@b.c", "/ evil", "/a b", "/\tevil", "/\nevil", "/a\r\nb", "/a\\b",
    "/\u0000", "/\u007f", " /a", "/" + "a".repeat(2100), null, undefined, 5, {}, ["/a"],
  ];
  for (const value of refused) assert.equal(safeInternalHref(value), null, JSON.stringify(value));
});
