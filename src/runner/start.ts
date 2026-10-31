import { startRunner } from "./server";
import { AppError } from "@/lib/app-error";

void startRunner().catch((error) => {
  console.error(error instanceof AppError ? `[runner] ${error.message}` : "[runner] démarrage impossible : vérifier la configuration et l'identité TEE");
  process.exitCode = 1;
});
