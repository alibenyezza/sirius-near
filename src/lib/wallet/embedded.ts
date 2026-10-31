"use client";

import { Web3Auth } from "@web3auth/modal";
import {
  WEB3AUTH_NETWORK,
  CHAIN_NAMESPACES,
  WALLET_CONNECTORS,
  AUTH_CONNECTION,
  CONNECTOR_EVENTS,
  CONNECTOR_STATUS,
} from "@web3auth/modal";
import { chainForNetwork, resolveClientNetwork } from "@/lib/evm/networks";
import { notifyWalletChange, registerEmbeddedWallet } from "@/lib/wallet/discovery";
import type { Eip1193Provider } from "@/lib/wallet/manager";

/**
 * Portefeuille embarqué : une EOA dérivée d'une connexion Google.
 *
 * Le reste de l'application parle à un portefeuille par une seule porte — un objet qui
 * répond à `request({ method, params })`. Une extension en est une ; ce module en est une
 * autre, dont la clé est reconstituée dans le navigateur à partir de parts distribuées
 * plutôt que lue dans une extension.
 *
 * Ce qui sort est une signature ECDSA ordinaire de 65 octets. C'est la seule propriété qui
 * compte ici : `recoverWalletAddress` est un `ecrecover` pur, et le runner n'accepte rien
 * d'autre — un compte contractuel (ERC-1271, ERC-4337) authentifierait la connexion mais
 * ne pourrait ni publier, ni entraîner, ni emprunter. D'où une EOA, et pas un smart account.
 *
 * Rien côté serveur ne distingue ce chemin de l'autre, et c'est voulu : il n'y a pas de
 * « session Google » dans Sirius, seulement une adresse qui a signé.
 */

function clientId(): string | null {
  return process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID?.trim() || null;
}

/**
 * Réseau du portefeuille embarqué, distinct du réseau EVM.
 *
 * `sapphire_devnet` et `sapphire_mainnet` sont deux dérivations séparées : le même compte
 * Google y produit deux adresses différentes. En changer après coup vide le compte de tous
 * les utilisateurs sans aucune erreur visible — d'où la valeur explicite plutôt qu'un défaut.
 */
function reseauEmbarque() {
  const demande = process.env.NEXT_PUBLIC_WEB3AUTH_NETWORK?.trim();
  if (demande === "sapphire_mainnet") return WEB3AUTH_NETWORK.SAPPHIRE_MAINNET;
  if (!demande || demande === "sapphire_devnet") return WEB3AUTH_NETWORK.SAPPHIRE_DEVNET;
  // Une faute de frappe retombait sur le devnet et donnait à chacun une adresse jetable,
  // sans rien signaler. Mieux vaut refuser la connexion et nommer la variable.
  throw new Error("Réseau Web3Auth inconnu — vérifie NEXT_PUBLIC_WEB3AUTH_NETWORK.");
}

/**
 * Configuration de chaîne dérivée de `networks.ts` plutôt que recopiée.
 *
 * Deux descriptions de la même chaîne finiraient par diverger, et la panne serait muette :
 * le portefeuille signerait pour un `chainId` que le serveur n'attend pas, et les
 * délégations seraient rejetées sans que rien n'indique pourquoi.
 */
function chaine() {
  const chain = chainForNetwork(resolveClientNetwork());
  return {
    chainNamespace: CHAIN_NAMESPACES.EIP155,
    chainId: `0x${chain.id.toString(16)}`,
    rpcTarget: chain.rpcUrls.default.http[0],
    displayName: chain.name,
    blockExplorerUrl: chain.blockExplorers?.default.url ?? "",
    ticker: chain.nativeCurrency.symbol,
    tickerName: chain.nativeCurrency.name,
    decimals: chain.nativeCurrency.decimals,
    // Purement décoratif — l'icône de la monnaie dans les écrans du SDK. Exigée par son
    // type, d'où une valeur explicite plutôt qu'une chaîne vide qui afficherait un trou.
    logo: "https://images.toruswallet.io/eth.svg",
  };
}

let instance: Web3Auth | null = null;
let demarrage: Promise<Web3Auth> | null = null;

/**
 * Instance unique, initialisée une seule fois.
 *
 * `init()` ouvre une session et restaure celle du stockage local ; l'appeler deux fois en
 * parallèle — deux composants qui montent ensemble — produit deux sessions concurrentes.
 * La promesse est donc mémorisée, pas seulement l'instance.
 */
async function client(): Promise<Web3Auth> {
  const id = clientId();
  if (!id) throw new Error("Connexion Google indisponible sur cette instance.");
  if (instance) return instance;
  if (demarrage) return demarrage;

  demarrage = (async () => {
    const web3auth = new Web3Auth({
      clientId: id,
      web3AuthNetwork: reseauEmbarque(),
      chains: [chaine()],
      defaultChainId: chaine().chainId,
      // Sans cela, le SDK lance sa propre découverte EIP-6963 et propose les extensions
      // installées. Sirius a déjà la sienne dans `discovery.ts`, et deux sélecteurs
      // concurrents rendraient le portefeuille effectivement utilisé imprévisible.
      multiInjectedProviderDiscovery: false,
      // Le SDK expédie sa télémétrie à Segment. Un produit dont l'argument est que personne
      // ne voit les données de ses utilisateurs ne peut pas envoyer leurs gestes à un tiers,
      // et notre CSP le bloquerait de toute façon — autant ne pas l'émettre.
      disableAnalytics: true,
      // Par défaut, le SDK approuve seul signatures et transactions du portefeuille embarqué
      // (« auto-approve ») : tout script de la page pourrait alors envoyer un transfert ou un
      // approve sans que l'utilisateur voie le montant. On impose une fenêtre de confirmation
      // à chaque demande, et l'export de la clé privée reste fermé depuis l'interface.
      // Valeurs du code prioritaires sur le tableau de bord Web3Auth ; sans `enableKeyExport`
      // explicite, le SDK l'active par défaut. `loginMode` est imposé à « plugin » par le
      // connecteur ; il n'est renseigné ici que parce que le type l'exige.
      walletServicesConfig: {
        loginMode: "plugin",
        confirmationStrategy: "modal",
        enableKeyExport: false,
      },
    });
    await web3auth.init();
    instance = web3auth;
    return web3auth;
  })();

  try {
    return await demarrage;
  } catch (error) {
    // Un échec d'initialisation ne doit pas condamner la page : sans cette remise à zéro,
    // la promesse rejetée resterait mémorisée et toute tentative ultérieure échouerait
    // avec la première erreur, même si la cause a disparu.
    demarrage = null;
    throw error;
  }
}

/**
 * Ouvre la connexion Google et rend le compte obtenu.
 *
 * On vise directement le connecteur Google plutôt que d'ouvrir le sélecteur du SDK :
 * l'utilisateur a déjà fait ce choix en cliquant « Continuer avec Google », et lui
 * présenter une seconde fenêtre de sélection serait un pas de plus pour rien.
 */
/**
 * Plafond d'attente de l'ouverture de session.
 *
 * Large à dessein : derrière se trouve un écran Google où quelqu'un tape un mot de passe et
 * valide peut-être un second facteur. Couper court transformerait une connexion lente en
 * échec.
 *
 * Il existe néanmoins, parce que le SDK sait rejeter dans une promesse qu'il ne chaîne pas à
 * celle qu'il rend : l'appelant n'apprend alors jamais l'échec et l'interface reste sur
 * « Connexion… » indéfiniment. C'est exactement ce qu'a produit une iframe bloquée.
 */
const DELAI_CONNEXION_MS = 3 * 60_000;

function borner<T>(promesse: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const minuteur = setTimeout(() => reject(new Error(message)), DELAI_CONNEXION_MS);
    promesse.then(resolve, reject).finally(() => clearTimeout(minuteur));
  });
}

/**
 * Attend que le connecteur social soit réellement utilisable.
 *
 * `init()` rend la main avant que ses connecteurs aient fini de s'initialiser. Enchaîner
 * directement sur `connectTo` tombe alors sur « connector is not ready » — et le SDK lève
 * cette erreur dans une promesse qu'il ne chaîne pas à celle qu'il rend, donc l'appelant
 * n'apprend rien et l'interface attend un résultat qui n'arrivera jamais.
 *
 * On écoute donc l'état plutôt que de le supposer. Le contrôle est refait après la pose de
 * l'écouteur : entre le premier test et l'abonnement, l'événement a pu passer.
 */
const DELAI_PRET_MS = 20_000;

async function attendrePret(web3auth: Web3Auth): Promise<void> {
  if (web3auth.status !== CONNECTOR_STATUS.NOT_READY) return;
  await new Promise<void>((resolve, reject) => {
    const nettoyer = () => {
      clearTimeout(minuteur);
      web3auth.off(CONNECTOR_EVENTS.READY, pret);
    };
    const pret = () => {
      nettoyer();
      resolve();
    };
    const minuteur = setTimeout(() => {
      nettoyer();
      reject(new Error("Connexion Google indisponible — réessaie dans un instant."));
    }, DELAI_PRET_MS);
    web3auth.on(CONNECTOR_EVENTS.READY, pret);
    if (web3auth.status !== CONNECTOR_STATUS.NOT_READY) pret();
  });
}

export async function connectEmbedded(): Promise<{ address: string; chainId: string }> {
  const web3auth = await client();
  let connexion = web3auth.connected ? web3auth.connection : null;
  if (!connexion) {
    await attendrePret(web3auth);
    connexion = await borner(
      web3auth.connectTo(WALLET_CONNECTORS.AUTH, { authConnection: AUTH_CONNECTION.GOOGLE }),
      "La connexion Google n’a pas abouti — réessaie.",
    );
  }

  const provider = connexion?.ethereumProvider;
  if (!provider) throw new Error("Connexion Google interrompue.");
  notifyWalletChange();

  const accounts = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new Error("Aucun compte n’a été créé.");
  }
  const chainId = await provider.request({ method: "eth_chainId" });
  if (typeof chainId !== "string") throw new Error("Réseau EVM indisponible.");

  return { address: accounts[0], chainId };
}

/**
 * Provider du portefeuille embarqué, s'il est connecté.
 *
 * Synchrone et sans effet de bord : `selectedProvider()` est appelé à chaque rendu, et
 * déclencher une initialisation depuis un chemin de lecture ouvrirait une fenêtre de
 * connexion sans que personne ne l'ait demandée.
 */
export function embeddedProvider(): Eip1193Provider | null {
  // La session compte autant que l'objet : après un `logout()`, le SDK peut encore exposer
  // un provider, et le rendre ferait croire à une session ouverte — l'application signerait
  // alors sous une adresse dont l'utilisateur vient de sortir.
  if (!instance?.connected) return null;

  // On passe par `connection`, et non par `web3auth.provider`. Ce dernier compile — l'interface
  // le promet — mais la classe ne définit qu'un *setter* : la lecture rend `undefined` à
  // l'exécution, quoi qu'il arrive. Le type ne protège de rien ici.
  const provider = instance.connection?.ethereumProvider;
  return provider ? (provider as Eip1193Provider) : null;
}

/** Vrai une fois la session sociale ouverte, y compris après restauration au chargement. */
export function embeddedConnected(): boolean {
  return Boolean(instance?.connected);
}

/**
 * Ferme la session sociale.
 *
 * `wallet_revokePermissions` n'existe pas ici : il n'y a aucune permission à retirer à une
 * extension, seulement une session à fermer. Sans cet appel, la déconnexion de Sirius
 * laisserait la session du SDK ouverte et le rechargement suivant reconnecterait tout seul.
 */
export async function disconnectEmbedded(): Promise<void> {
  if (!instance?.connected) return;
  await instance.logout();
}

/**
 * Bascule de chaîne par le SDK plutôt que par le provider.
 *
 * Une extension reçoit `wallet_switchEthereumChain` et peut proposer d'ajouter la chaîne si
 * elle ne la connaît pas. Ici la liste est figée à la configuration : il n'y a rien à
 * ajouter, seulement à désigner laquelle est active.
 */
async function switchEmbeddedChain(chainId: string): Promise<void> {
  const web3auth = await client();
  await web3auth.switchChain({ chainId });
}

/**
 * Identité lisible de l'utilisateur, pour l'afficher à la place d'une adresse hexadécimale.
 *
 * Jamais transmise au serveur ni utilisée pour autoriser quoi que ce soit : l'autorisation
 * passe par la signature, comme pour n'importe quel portefeuille. C'est un confort
 * d'affichage, et il échoue en silence.
 */
export async function embeddedUserEmail(): Promise<string | null> {
  if (!instance?.connected) return null;
  try {
    const info = await instance.getUserInfo();
    return info.email ?? info.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Rouvre la session sociale d'un rechargement de page.
 *
 * Le store du portefeuille ne persiste pas — il doit refléter le provider vivant — alors
 * que le SDK, lui, garde sa session dans le stockage du navigateur. Sans cette reprise,
 * l'utilisateur reviendrait sur une page déconnectée en ayant toujours une session ouverte
 * des deux côtés, et le cookie de Sirius le contredirait.
 *
 * Rend `true` si une session a effectivement été retrouvée. Une absence n'est pas une
 * erreur : c'est le cas normal du premier passage.
 */
export async function restoreEmbedded(): Promise<boolean> {
  if (!clientId()) return false;
  try {
    const web3auth = await client();
    if (web3auth.connected) notifyWalletChange();
    return web3auth.connected;
  } catch {
    // Reprise impossible — réseau coupé, session expirée côté SDK. L'utilisateur reste
    // déconnecté et peut recliquer ; échouer bruyamment ici bloquerait le rendu de la page.
    return false;
  }
}

// Déclaré au chargement du module plutôt qu'après connexion : le lecteur rend `null` tant
// qu'aucune session n'est ouverte, et l'enregistrer tôt évite une fenêtre où le provider
// existe sans que `selectedProvider()` sache le trouver.
registerEmbeddedWallet({
  provider: embeddedProvider,
  switchChain: switchEmbeddedChain,
  logout: disconnectEmbedded,
});
