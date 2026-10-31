import { pathToFileURL } from "node:url";

const targets = {
  main: {
    environnement: "production",
    projet_compose: "sirius",
    projet_vercel: "prj_gmEKctb6EJcsErIQqamKiZNaK5vZ",
    dossier_vps: "/opt/sirius",
    url_publique: "https://sirius-data.tech",
    origines_alias: "https://sirius-evm.vercel.app,https://sirius-evm-byezzaali-gmailcoms-projects.vercel.app",
  },
  staging: {
    environnement: "staging",
    projet_compose: "sirius-staging",
    projet_vercel: "prj_ZTusbshyQVU5S0KUXpOhK2TW9Wnz",
    dossier_vps: "/opt/sirius-staging",
    // D-26 : le projet staging est l'instance Phala de démonstration ; l'ancienne origine reste en alias.
    url_publique: "https://phala.sirius-data.tech",
    // demo.sirius-data.tech : déploiement staging figé, réservé à la session de training (src/lib/phala-demo/demo-host.ts).
    origines_alias: "https://sirius-evm-staging.vercel.app,https://sirius-evm-staging-byezzaali-gmailcoms-projects.vercel.app,https://demo.sirius-data.tech",
  },
};

export function deploymentTarget(ref, stagingPhalaRequired = "false") {
  const branch = typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : "";
  if (!Object.hasOwn(targets, branch)) {
    throw new Error("Branche de déploiement refusée : seules main et staging sont autorisées.");
  }
  if (branch === "staging" && !["false", "true"].includes(stagingPhalaRequired)) {
    throw new Error("SIRIUS_STAGING_REQUIRE_PHALA doit valoir true ou false.");
  }
  return { branche: branch, ...targets[branch], phala_requis: branch === "staging" ? stagingPhalaRequired : "true" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const target = deploymentTarget(process.argv[2], process.env.SIRIUS_STAGING_REQUIRE_PHALA || "false");
    for (const [key, value] of Object.entries(target)) console.log(`${key}=${value}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
