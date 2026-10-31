/** Erreur métier volontaire : son message est sûr à exposer au client. Sans dépendance Next
 *  → importable par le runner isolé (inc.3d-B) sans tirer `next/server`. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}
