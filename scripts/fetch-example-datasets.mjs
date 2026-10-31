import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/examples/regression/bike-sharing-demand.csv");
const source = "https://www.archive.ics.uci.edu/static/public/275/bike+sharing+dataset.zip";

const columns = [
  "season",
  "yr",
  "mnth",
  "hr",
  "holiday",
  "weekday",
  "workingday",
  "weathersit",
  "temp",
  "atemp",
  "hum",
  "windspeed",
  "cnt",
];

async function main() {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Téléchargement UCI échoué (${response.status})`);

  const workspace = await mkdtemp(resolve(tmpdir(), "sirius-bike-sharing-"));
  try {
    const archive = resolve(workspace, "bike-sharing.zip");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const { stdout } = await execFileAsync("unzip", ["-p", archive, "Bike-Sharing-Dataset/hour.csv"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const [header, ...rows] = stdout.trim().split("\n");
    const positions = Object.fromEntries(header.replace(/\r$/, "").split(",").map((column, index) => [column, index]));
    if (columns.some((column) => positions[column] === undefined)) {
      throw new Error("Colonnes UCI inattendues");
    }

    const normalized = rows.map((line) => {
      const values = line.replace(/\r$/, "").split(",");
      const selected = columns.map((column) => values[positions[column]]);
      if (selected.some((value) => value === undefined || value === "" || !Number.isFinite(Number(value)))) {
        throw new Error("Valeur UCI non numérique inattendue");
      }
      return selected.join(",");
    });
    if (normalized.length < 100 || normalized.length > 20_000) {
      throw new Error(`Nombre de lignes incompatible avec Sirius : ${normalized.length}`);
    }

    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${columns.join(",")}\n${normalized.join("\n")}\n`);
    console.log(`Dataset réel écrit : ${output} (${normalized.length} lignes)`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
