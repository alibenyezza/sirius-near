/**
 * Point d'accroche de la visite guidée (docs/passage-mainnet/04-dashboard.md : « Relançable
 * à tout moment : bouton Visite guidée dans le menu profil »).
 *
 * Le composant de visite (le guide Sirio, `src/components/guide/GuideHost.tsx`) est porté par
 * une autre tranche. Pour ne pas dépendre de lui, le menu profil émet un événement DOM et c'est
 * le composant de visite qui s'y abonne (`subscribeGuidedTourRequests`, `guide-store.ts`) :
 *
 *   useEffect(() => {
 *     const onStart = (event: Event) => {
 *       event.preventDefault(); // dit à l'émetteur « je prends en charge la demande »
 *       restartTour();
 *     };
 *     window.addEventListener(GUIDED_TOUR_EVENT, onStart);
 *     return () => window.removeEventListener(GUIDED_TOUR_EVENT, onStart);
 *   }, []);
 *
 * L'événement est annulable : `preventDefault()` est l'accusé de réception. Sans abonné,
 * `requestGuidedTour` renvoie `false` et le menu affiche « bientôt disponible » au lieu
 * d'un clic sans effet.
 */
export const GUIDED_TOUR_EVENT = "sirius:guided-tour:start";

/** Demande le lancement de la visite. Vrai si un composant l'a prise en charge. */
export function requestGuidedTour(target: EventTarget = window): boolean {
  const event = new Event(GUIDED_TOUR_EVENT, { cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
