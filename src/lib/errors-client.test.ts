import { test } from "node:test";
import assert from "node:assert/strict";
import { messageOf } from "./errors-client";

/**
 * Les portefeuilles ne rejettent pas avec des `Error`.
 *
 * MetaMask lève `{ code: 4001, message: "User rejected" }`, viem emboîte la vraie
 * raison sous `cause`, et un `instanceof Error` échoue sur les deux. L'utilisateur
 * voyait alors « une erreur est survenue » — un message qui ne dit rien, là où le
 * portefeuille avait été parfaitement explicite.
 */

test("un rejet EIP-1193 est traduit en une phrase utile", () => {
  assert.equal(messageOf({ code: 4001, message: "User rejected the request" }), "Transaction refusée dans le wallet.");
  assert.equal(messageOf({ code: -32002 }), "Une demande est déjà en attente dans le wallet — ouvre-le.");
});

test("shortMessage l'emporte sur message, qui porte la stacktrace", () => {
  assert.equal(
    messageOf({ shortMessage: "Execution reverted.", message: "Execution reverted.\n  at foo\n  at bar" }),
    "Execution reverted.",
  );
});

test("la raison est trouvée même emboîtée sous cause", () => {
  assert.equal(messageOf({ cause: { code: 4001 } }), "Transaction refusée dans le wallet.");
  assert.equal(messageOf({ cause: { cause: { shortMessage: "Insufficient funds" } } }), "Insufficient funds");
});

test("un Error ordinaire garde son message", () => {
  assert.equal(messageOf(new Error("Montant invalide")), "Montant invalide");
});

test("seule une valeur vraiment muette produit le message générique", () => {
  assert.equal(messageOf(undefined), "Une erreur est survenue");
  assert.equal(messageOf({}), "Une erreur est survenue");
});

test("une récursion cyclique ne fait pas boucler", () => {
  const boucle: Record<string, unknown> = {};
  boucle.cause = boucle;
  assert.equal(messageOf(boucle), "Une erreur est survenue");
});
