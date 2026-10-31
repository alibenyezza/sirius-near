import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const datasets = [
  {
    directory: "regression",
    name: "housing-prices",
    split: (rows) => rows.reduce(
      (groups, row, index) => {
        groups[index % 5 === 4 ? 1 : 0].push(row);
        return groups;
      },
      [[], []],
    ),
  },
  {
    directory: "regression",
    name: "energy-demand",
    split: (rows) => {
      const boundary = Math.floor(rows.length * 0.8);
      return [rows.slice(0, boundary), rows.slice(boundary)];
    },
  },
  {
    directory: "regression",
    name: "bike-sharing-demand",
    optional: true,
    split: (rows) => {
      const boundary = Math.floor(rows.length * 0.8);
      return [rows.slice(0, boundary), rows.slice(boundary)];
    },
  },
  {
    directory: "classification",
    name: "credit-default",
    split: (rows) => rows.reduce(
      (groups, row, index) => {
        groups[index % 5 === 4 ? 1 : 0].push(row);
        return groups;
      },
      [[], []],
    ),
  },
];

async function splitDataset({ directory, name, optional, split }) {
  const source = resolve(root, `public/examples/${directory}/${name}.csv`);
  let content;
  try {
    content = await readFile(source, "utf8");
  } catch (error) {
    if (optional && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  const [header, ...rows] = content.trim().split(/\r?\n/);
  if (!header || rows.length < 125) throw new Error(`${name}: jeu source trop petit pour une séparation`);
  const [train, test] = split(rows);
  if (train.length < 100 || test.length < 20) throw new Error(`${name}: séparation train/test invalide`);

  await Promise.all([
    writeFile(resolve(root, `public/examples/${directory}/${name}-train.csv`), `${header}\n${train.join("\n")}\n`),
    writeFile(resolve(root, `public/examples/${directory}/${name}-test.csv`), `${header}\n${test.join("\n")}\n`),
  ]);
  console.log(`${name}: ${train.length} lignes train, ${test.length} lignes test`);
}

async function main() {
  for (const dataset of datasets) await splitDataset(dataset);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
