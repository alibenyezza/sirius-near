import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const regressionOutput = resolve(root, "public/examples/regression/energy-demand.csv");
const classificationOutput = resolve(root, "public/examples/classification/credit-default.csv");

let state = 42;
function random() {
  state = (state * 1_664_525 + 1_013_904_223) >>> 0;
  return state / 2 ** 32;
}

function normal() {
  const radius = Math.sqrt(-2 * Math.log(Math.max(random(), Number.MIN_VALUE)));
  return radius * Math.cos(2 * Math.PI * random());
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function sigmoid(value) {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

function peak(hour, center) {
  return Math.exp(-((hour - center) ** 2) / 4);
}

function energyDemandRows() {
  const header = [
    "hour",
    "temperature_c",
    "humidity_pct",
    "wind_kmh",
    "cloud_cover_pct",
    "is_weekend",
    "is_holiday",
    "solar_kw",
    "morning_peak",
    "evening_peak",
    "energy_mwh",
  ];
  const rows = [header.join(",")];

  for (let index = 0; index < 8_760; index++) {
    const day = Math.floor(index / 24);
    const hour = index % 24;
    const weekend = Number(day % 7 >= 5);
    const holiday = Number(day === 0 || day === 119 || day === 358);
    const temperature = 14 + 11 * Math.sin((2 * Math.PI * (day - 78)) / 365) + (random() - 0.5) * 4;
    const humidity = 62 + (random() - 0.5) * 36;
    const wind = 12 + (random() - 0.5) * 18;
    const clouds = Math.min(100, Math.max(0, 55 + (random() - 0.5) * 80));
    const solar = Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12)) * (1 - clouds / 130) * 45;
    const morning = peak(hour, 8);
    const evening = peak(hour, 19);
    const noise = (random() - 0.5) * 10;
    const demand = 54 - 0.7 * temperature + 0.14 * humidity + 0.18 * wind + 0.06 * clouds + 8 * weekend - 10 * holiday - 0.02 * solar + 31 * morning + 45 * evening + noise;

    rows.push([
      hour,
      temperature.toFixed(2),
      humidity.toFixed(2),
      wind.toFixed(2),
      clouds.toFixed(2),
      weekend,
      holiday,
      solar.toFixed(2),
      morning.toFixed(6),
      evening.toFixed(6),
      demand.toFixed(2),
    ].join(","));
  }

  return rows;
}

function creditDefaultRows() {
  const rows = ["income_k_eur,debt_ratio_pct,credit_score,late_payments,utilization_pct,employment_years,defaulted"];
  for (let index = 0; index < 600; index++) {
    const income = clamp(55 + normal() * 18, 18, 160);
    const debtRatio = clamp(38 - 0.12 * (income - 55) + normal() * 18, 5, 95);
    const creditScore = clamp(685 + 0.8 * (income - 55) - 1.4 * (debtRatio - 38) + normal() * 45, 300, 850);
    const latePayments = clamp(Math.round(0.5 + 0.035 * (debtRatio - 35) + (690 - creditScore) / 90 + normal() * 0.8), 0, 8);
    const utilization = clamp(40 + 0.55 * (debtRatio - 38) + normal() * 20, 3, 99);
    const employmentYears = clamp(Math.round(6 + 0.08 * (income - 55) + normal() * 4), 0, 30);
    const risk =
      -1.1 +
      0.033 * (debtRatio - 38) +
      0.022 * (utilization - 40) -
      0.012 * (creditScore - 680) +
      0.35 * latePayments -
      0.015 * (income - 55) -
      0.04 * (employmentYears - 6) +
      normal() * 0.7;
    const defaulted = Number(random() < sigmoid(risk));
    rows.push([
      income.toFixed(2),
      debtRatio.toFixed(2),
      creditScore.toFixed(0),
      latePayments,
      utilization.toFixed(2),
      employmentYears,
      defaulted,
    ].join(","));
  }
  return rows;
}

async function writeDataset(output, rows) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${rows.join("\n")}\n`);
}

async function main() {
  const energyRows = energyDemandRows();
  const classificationRows = creditDefaultRows();
  await Promise.all([
    writeDataset(regressionOutput, energyRows),
    writeDataset(classificationOutput, classificationRows),
  ]);
  console.log(`Dataset synthétique écrit : ${regressionOutput} (8760 lignes)`);
  console.log(`Dataset synthétique écrit : ${classificationOutput} (600 lignes)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
