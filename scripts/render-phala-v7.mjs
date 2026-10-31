import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Origine HTTPS nue, sans chemin, requête ni port : celle que le runner compare aux délégations. */
export function appOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Origine de l'application invalide"); }
  if (url.protocol !== "https:" || url.origin !== value || url.port) throw new Error("Origine de l'application invalide");
  return url.origin;
}

export function renderPhalaV7(mode, image, origin) {
  if (!["bootstrap", "init", "active", "wallets", "demo-init", "demo-active"].includes(mode)
    || !/^ghcr\.io\/dvb-ali-noe\/sirius-runner@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Mode ou digest immuable invalide");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const demo = mode.startsWith("demo-");
  // La démonstration lit son origine dans l'environnement chiffré. Toute autre instance la
  // reçoit explicitement : plus aucune origine staging imposée par défaut.
  if (demo ? origin !== undefined : !origin) throw new Error("Origine de l'application requise hors démonstration");
  const runnerOrigin = demo ? "${SIRIUS_APP_ORIGIN}" : appOrigin(origin);
  const files = ["compose.yaml", ["active", "demo-active"].includes(mode) ? "compose.v7.yaml" : "compose.bootstrap-v7.yaml"];
  if (mode === "init" || mode === "demo-init") files.push("compose.init-v7.yaml");
  if (mode === "wallets") files.push("compose.trial-wallets.yaml");
  if (demo) files.push("compose.demo.yaml");
  const args = ["compose", ...files.flatMap((name) => ["-f", resolve(root, "deploy/phala", name)]),
    "config", "--no-interpolate", "--no-env-resolution", "--format", "json"];
  const model = JSON.parse(execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }));
  // Les noms calculés sur le poste local détacheraient les volumes persistants de la CVM.
  delete model.name;
  for (const [name, volume] of Object.entries(model.volumes)) {
    if (!demo) delete volume.name;
    else if (volume.name !== ({ runner_budget: "sirius_phala_demo_budget", runner_replay: "sirius_phala_demo_replay" })[name]) throw new Error("Volume de démonstration inattendu");
  }
  for (const network of Object.values(model.networks ?? {})) delete network.name;
  for (const service of Object.values(model.services)) {
    service.image = image;
    if (Array.isArray(service.environment)) service.environment = Object.fromEntries(service.environment.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) throw new Error("Variable héritée implicitement refusée");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  model.services.runner.environment.SIRIUS_APP_ORIGIN = runnerOrigin;
  if (model.services.runner.environment.RUNNER_TRANSPORT_SECRET !== "${RUNNER_TRANSPORT_SECRET}"
    || model.services.runner.environment.PINATA_JWT !== "${PINATA_JWT}") throw new Error("Interpolation de secret refusée");
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const flags = args.filter((arg) => arg.startsWith("--"));
    const [mode, image, destination, ...extra] = args.filter((arg) => !arg.startsWith("--"));
    const origin = flags.length === 1 && flags[0].startsWith("--origin=") ? flags[0].slice("--origin=".length) : undefined;
    if (!destination || extra.length || flags.length > 1 || (flags.length && origin === undefined)) throw new Error();
    const model = renderPhalaV7(mode, image, origin);
    const fd = openSync(destination, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(model, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    console.log(`Compose ${mode} préparé pour ${model.services.runner.environment.SIRIUS_APP_ORIGIN} ; image figée, variables chiffrées non interpolées.`);
  } catch {
    console.error("Préparation Compose refusée : vérifier le mode, le digest, --origin=https://… (obligatoire hors démonstration), Docker Compose et un fichier de sortie inexistant. Aucun déploiement effectué.");
    process.exitCode = 1;
  }
}
