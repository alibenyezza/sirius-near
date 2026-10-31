/**
 * Forme canonique d'un identifiant de compte, utilisée partout où une adresse sert de
 * **clé** : contexte de dérivation cryptographique, identifiant d'enregistrement local,
 * données additionnelles authentifiées.
 *
 * Le problème qu'elle ferme est silencieux, et c'est ce qui le rend dangereux. Une
 * adresse EVM encode sa somme de contrôle dans la casse (EIP-55) : `0xAbC…` et
 * `0xabc…` désignent le même compte tout en étant deux chaînes différentes. Si le
 * runner dérive la clé d'un modèle avec l'une puis la relit avec l'autre, la clé
 * rendue ne déchiffre rien — et **aucune exception n'est levée** : on obtient un
 * échec d'authentification AES-GCM, indiscernable d'une corruption de données.
 *
 * Idempotente : l'appliquer deux fois donne le même résultat.
 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function canonicalSubject(address: string): string {
  return EVM_ADDRESS.test(address) ? address.toLowerCase() : address;
}
