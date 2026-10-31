/**
 * Mode de déploiement de l'instance.
 *
 * Une instance « démonstration » est construite comme la production mais servie sur
 * un réseau de test, avec ou sans enclave attestée. Elle existe parce que `NODE_ENV` ne dit
 * qu'une chose — le code est compilé pour être servi — là où plusieurs contrôles en
 * supposaient une autre : que l'instance EST le produit final, sur mainnet, derrière
 * un TEE dont les mesures sont épinglées.
 *
 * Le mode se déduit du réseau plutôt que de se déclarer. `instrumentation-node.ts`
 * exigeait déjà mainnet pour toute instance de production qui n'est PAS en
 * démonstration : servir un testnet au public sans être en démonstration était donc
 * déjà interdit au démarrage. Le déduire ne relâche rien, cela rend explicite une
 * contrainte que l'application imposait, et supprime une variable qu'on pouvait
 * oublier — auquel cas l'attestation parrainée et la distribution de fonds de test
 * échouaient toutes deux, sans que rien ne relie la panne à sa cause.
 *
 * Le drapeau explicite reste accepté : il permet de forcer le mode dans un contexte
 * où le réseau n'est pas encore résolu. Il ne peut en revanche rien débloquer sur
 * mainnet — `instrumentation-node.ts` refuse de démarrer dans ce cas, et c'est ce
 * refus, pas cette fonction, qui tient la garantie.
 * SIRIUS_REQUIRE_PHALA impose séparément une enclave sur main, même sur testnet.
 */
export function isDemoDeployment(): boolean {
  if (process.env.SIRIUS_DEPLOYMENT_MODE === "demo") return true;

  // Accès en toutes lettres : une lecture par clé calculée n'est pas inlinée par Next
  // et vaudrait `undefined` dans tout bundle navigateur.
  const network = process.env.EVM_NETWORK?.trim() || process.env.NEXT_PUBLIC_EVM_NETWORK?.trim();
  return network === "testnet";
}
