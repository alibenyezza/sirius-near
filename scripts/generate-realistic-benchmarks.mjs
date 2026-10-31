import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/examples/benchmarks");

let state = 0x4d595df4;
let spareNormal;

function random() {
  state = (state * 1_664_525 + 1_013_904_223) >>> 0;
  return state / 2 ** 32;
}

function normal(mean = 0, deviation = 1) {
  if (spareNormal !== undefined) {
    const value = spareNormal;
    spareNormal = undefined;
    return mean + value * deviation;
  }
  const radius = Math.sqrt(-2 * Math.log(Math.max(random(), Number.MIN_VALUE)));
  const angle = 2 * Math.PI * random();
  spareNormal = radius * Math.sin(angle);
  return mean + radius * Math.cos(angle) * deviation;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function choose(items) {
  return items[Math.floor(random() * items.length)];
}

function weightedChoose(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let threshold = random() * total;
  for (const item of items) {
    threshold -= item.weight;
    if (threshold <= 0) return item;
  }
  return items.at(-1);
}

function decimal(value, digits = 2) {
  return Number(value.toFixed(digits));
}

async function writeSplit(name, header, rows) {
  const splitAt = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, splitAt);
  const test = rows.slice(splitAt);
  if (train.length < 100 || test.length < 20) throw new Error(`${name}: séparation invalide`);
  await Promise.all([
    writeFile(resolve(output, `${name}-train.csv`), `${header.join(",")}\n${train.map((row) => row.join(",")).join("\n")}\n`),
    writeFile(resolve(output, `${name}-test.csv`), `${header.join(",")}\n${test.map((row) => row.join(",")).join("\n")}\n`),
  ]);
  console.log(`${name}: ${train.length} train, ${test.length} test`);
}

function vehicleResaleRows() {
  const makes = [
    { name: "Aster", premium: -2_800, weight: 20 },
    { name: "Boreal", premium: 1_400, weight: 24 },
    { name: "Cobalt", premium: 6_600, weight: 18 },
    { name: "Dune", premium: 10_500, weight: 10 },
    { name: "Ember", premium: -1_200, weight: 16 },
    { name: "Fjord", premium: 4_200, weight: 12 },
  ];
  const bodies = [
    { name: "compact", premium: -2_000, weight: 27 },
    { name: "sedan", premium: 1_300, weight: 22 },
    { name: "suv", premium: 6_200, weight: 30 },
    { name: "wagon", premium: 2_200, weight: 12 },
    { name: "van", premium: 800, weight: 9 },
  ];
  const rows = [];
  for (let index = 0; index < 7_500; index++) {
    const month = Math.floor(index / 125);
    const make = weightedChoose(makes);
    const body = weightedChoose(bodies);
    const sellerType = choose(["dealer", "private", "fleet"]);
    const age = clamp(Math.round(normal(7.2 + month * 0.025, 4.1)), 0, 20);
    const mileage = clamp(normal(11_000 + age * 13_200, 24_000), 500, 360_000);
    const power = clamp(normal(body.name === "suv" ? 135 : 105, 34), 45, 310);
    const owners = clamp(Math.round(1 + age / 5 + normal(0, 0.7)), 1, 6);
    const serviceScore = clamp(normal(76 - age * 1.7, 13), 20, 100);
    const accidents = random() < 0.68 ? 0 : random() < 0.89 ? 1 : 2;
    const batteryHealth = clamp(100 - age * 2.8 + normal(0, 6), 42, 100);
    const fuelPrice = 100 + month * 0.32 + normal(0, 2.8);
    const incomeIndex = 100 + 5 * Math.sin(month / 5) + normal(0, 4);
    const interestRate = 3.1 + month * 0.025 + normal(0, 0.22);
    const trimPremium = choose([-5_500, -2_000, 0, 3_000, 7_000]);
    const sellerPremium = sellerType === "dealer" ? 1_800 : sellerType === "fleet" ? -2_400 : -300;
    const price = clamp(
      17_000 + make.premium + body.premium + trimPremium + sellerPremium + power * 95 + serviceScore * 115 + batteryHealth * 45 + incomeIndex * 70
        - age * 1_150 - mileage * 0.037 - mileage ** 2 * 0.000000025 - accidents * 3_900 - owners * 720
        - interestRate * 1_050 + (body.name === "suv" ? 24 * power : 0) - age * serviceScore * 9 + normal(0, 4_800 + age * 380),
      1_200,
      130_000,
    );
    rows.push([month, age, decimal(mileage), decimal(power), owners, decimal(serviceScore), accidents, decimal(batteryHealth), decimal(fuelPrice), decimal(incomeIndex), decimal(interestRate), make.name, body.name, sellerType, Math.round(price)]);
  }
  return rows;
}

function retailDemandRows() {
  const categories = [
    { name: "beverages", base: 78, priceSensitivity: 10, weight: 28 },
    { name: "snacks", base: 52, priceSensitivity: 8, weight: 24 },
    { name: "fresh", base: 40, priceSensitivity: 13, weight: 18 },
    { name: "homecare", base: 25, priceSensitivity: 5, weight: 16 },
    { name: "personalcare", base: 31, priceSensitivity: 6, weight: 14 },
  ];
  const formats = [
    { name: "urban", demand: 18, weight: 38 },
    { name: "suburban", demand: 7, weight: 42 },
    { name: "rural", demand: -10, weight: 20 },
  ];
  const rows = [];
  for (let index = 0; index < 12_600; index++) {
    const day = Math.floor(index / 35);
    const category = weightedChoose(categories);
    const store = weightedChoose(formats);
    const dayOfWeek = day % 7;
    const seasonal = 8 * Math.sin((2 * Math.PI * (day - 75)) / 365);
    const holiday = Number(day % 53 === 0 || day === 358 || day === 359);
    const weekend = Number(dayOfWeek >= 5);
    const basePrice = clamp(normal(category.name === "homecare" ? 8.5 : 4.2, 1.5), 1.1, 18);
    const discount = clamp(random() < 0.32 ? normal(18, 8) : normal(2, 1.6), 0, 45);
    const display = Number(random() < 0.27);
    const competitorPrice = clamp(basePrice * normal(1.04, 0.12), 0.8, 22);
    const temperature = 13 + 10 * Math.sin((2 * Math.PI * (day - 78)) / 365) + normal(0, 4);
    const rain = Math.max(0, normal(2.8, 4.5));
    const localIncome = 100 + 3 * Math.sin(day / 43) + normal(0, 5);
    const localEvent = choose(["none", "none", "none", "sports", "construction", "festival"]);
    const eventDemand = localEvent === "festival" ? 24 : localEvent === "sports" ? 11 : localEvent === "construction" ? -12 : 0;
    const expected = category.base + store.demand + seasonal + holiday * 17 + weekend * (category.name === "fresh" ? 8 : -2)
      + display * 13 + discount * category.priceSensitivity * 0.34 + (competitorPrice - basePrice) * 6 + (temperature - 18) * (category.name === "beverages" ? 1.1 : 0.12)
      - rain * (store.name === "urban" ? 0.4 : 0.75) + (localIncome - 100) * 0.5 + eventDemand;
    const stock = clamp(Math.round(normal(expected + 24, 28)), 4, 260);
    const supplyShock = random() < 0.055 ? normal(-22, 9) : 0;
    const sold = clamp(Math.round(Math.min(stock, expected + supplyShock + normal(0, 14 + Math.max(expected, 0) * 0.12))), 0, stock);
    rows.push([day, dayOfWeek, holiday, weekend, decimal(basePrice), decimal(discount), display, stock, decimal(competitorPrice), decimal(temperature), decimal(rain), decimal(localIncome), store.name, category.name, localEvent, sold]);
  }
  return rows;
}

function lastMileDeliveryRows() {
  const zones = [
    { name: "central", traffic: 18, weight: 32 },
    { name: "residential", traffic: 7, weight: 42 },
    { name: "peripheral", traffic: -3, weight: 26 },
  ];
  const services = [
    { name: "standard", buffer: 4, weight: 63 },
    { name: "express", buffer: -3, weight: 24 },
    { name: "bulky", buffer: 13, weight: 13 },
  ];
  const rows = [];
  for (let index = 0; index < 12_000; index++) {
    const day = Math.floor(index / 40);
    const hour = 7 + (index % 12);
    const zone = weightedChoose(zones);
    const service = weightedChoose(services);
    const weekday = day % 7;
    const weekend = Number(weekday >= 5);
    const holiday = Number(day % 61 === 0 || day === 359);
    const distance = clamp(random() < 0.1 ? normal(24, 8) : normal(8.5, 4.4), 0.5, 48);
    const rush = Number((hour >= 8 && hour <= 9) || (hour >= 17 && hour <= 19));
    const constructionShift = day > 245 && zone.name === "central" ? 9 : 0;
    const traffic = clamp(34 + zone.traffic + rush * 35 + weekend * -7 + constructionShift + normal(0, 9), 8, 98);
    const rain = Math.max(0, normal(2.5, 4.8));
    const temperature = 12 + 11 * Math.sin((2 * Math.PI * (day - 80)) / 365) + normal(0, 3.5);
    const parcels = clamp(Math.round(normal(service.name === "bulky" ? 5 : 14, 4)), 1, 28);
    const experience = clamp(normal(19, 14), 0, 96);
    const queue = clamp(normal(7 + rush * 10, 6), 0, 42);
    const density = clamp(normal(zone.name === "central" ? 88 : zone.name === "residential" ? 56 : 26, 13), 5, 100);
    const incident = random() < 0.035 ? choose(["roadwork", "vehicle", "customer_absent"]) : "none";
    const incidentDelay = incident === "roadwork" ? normal(18, 7) : incident === "vehicle" ? normal(32, 12) : incident === "customer_absent" ? normal(11, 5) : 0;
    const duration = clamp(7 + service.buffer + queue + parcels * 0.46 + distance * (1.06 + traffic * 0.019) + rain * 0.26 + Math.max(0, temperature - 29) * 0.32 - experience * 0.07 + density * 0.045 + incidentDelay + normal(0, 4.8), 8, 210);
    rows.push([day, hour, weekend, holiday, decimal(distance), decimal(traffic), decimal(rain), decimal(temperature), parcels, decimal(experience), decimal(queue), decimal(density), zone.name, service.name, incident, decimal(duration)]);
  }
  return rows;
}

function industrialYieldRows() {
  const teams = ["alpha", "bravo", "charlie", "delta"];
  const materials = ["standard", "recycled", "premium"];
  const rows = [];
  for (let index = 0; index < 19_500; index++) {
    const day = Math.floor(index / 54);
    const shift = index % 3;
    const team = teams[(shift + Math.floor(day / 11)) % teams.length];
    const material = choose(materials);
    const lineSpeed = clamp(normal(82, 11), 45, 116);
    const mixerRpm = clamp(normal(1_180, 100), 850, 1_480);
    const ovenTemp = clamp(normal(182, 6.5), 160, 204);
    const coolingTemp = clamp(normal(28, 4.5), 16, 42);
    const pressure = clamp(normal(5.8, 0.65), 3.8, 7.9);
    const viscosity = clamp(normal(1_300, 180), 760, 1_920);
    const moisture = clamp(normal(4.7, 0.8), 2.1, 7.6);
    const purity = clamp(normal(material === "premium" ? 98.4 : material === "recycled" ? 94.6 : 96.8, 0.8), 91, 99.8);
    const ambientTemp = clamp(18 + 9 * Math.sin((2 * Math.PI * (day - 70)) / 365) + normal(0, 3), 4, 35);
    const ambientHumidity = clamp(normal(54, 15), 18, 92);
    const wear = clamp(day * 2.8 + normal(0, 45), 0, 1_200);
    const tenure = clamp(normal(28, 19), 0, 120);
    const maintenance = clamp(Math.round(normal(14 + wear / 100, 7)), 0, 50);
    const vibration = clamp(normal(2.1 + wear / 700, 0.45), 0.5, 5.5);
    const power = clamp(normal(320 + lineSpeed * 1.1, 18), 260, 480);
    const tension = clamp(normal(1_150, 95), 850, 1_450);
    const nozzle = clamp(normal(3.2, 0.14), 2.75, 3.68);
    const feedRate = clamp(normal(lineSpeed * 8.4, 52), 340, 1_050);
    const ph = clamp(normal(6.9, 0.23), 6.1, 7.7);
    const density = clamp(normal(1_018, 18), 960, 1_080);
    const particleSize = clamp(normal(118, 19), 58, 190);
    const catalyst = clamp(normal(2.4, 0.32), 1.35, 3.45);
    const recirculation = clamp(normal(34, 7), 12, 58);
    const coolingFlow = clamp(normal(178, 23), 100, 255);
    const humiditySetpoint = clamp(normal(52, 6), 34, 72);
    const priorDefects = clamp(normal(1.6 + wear / 700, 0.75), 0, 6);
    const lineLoad = clamp(normal(76, 12), 35, 99);
    const supplierQuality = clamp(normal(day > 290 ? 94.4 : 96.5, 1.15), 90, 99.5);
    const calibration = clamp(normal(0, 0.18), -0.65, 0.65);
    const teamEffect = team === "alpha" ? 1.4 : team === "delta" ? -1.1 : team === "bravo" ? 0.5 : -0.2;
    const materialEffect = material === "premium" ? 1.6 : material === "recycled" ? -2.4 : 0;
    const fault = random() < 0.027 ? normal(-8, 2.5) : 0;
    const yieldPct = clamp(91 + teamEffect + materialEffect + (purity - 96) * 1.15 + (supplierQuality - 96) * 0.9 - (ovenTemp - 182) ** 2 * 0.045 - (viscosity - 1_300) ** 2 * 0.000022 - (moisture - 4.7) ** 2 * 1.3 - (pressure - 5.8) ** 2 * 1.8 - wear * 0.0025 - vibration * 1.45 - priorDefects * 0.9 + tenure * 0.018 - Math.abs(ph - 6.9) * 4 - Math.abs(nozzle - 3.2) * 6 - Math.max(0, lineSpeed - 92) * (wear / 1_000) * 0.35 + coolingFlow * 0.006 + calibration * 1.8 + fault + normal(0, 1.55), 45, 99.5);
    rows.push([index, shift, decimal(lineSpeed), decimal(mixerRpm), decimal(ovenTemp), decimal(coolingTemp), decimal(pressure), decimal(viscosity), decimal(moisture), decimal(purity), decimal(ambientTemp), decimal(ambientHumidity), decimal(wear), decimal(tenure), maintenance, decimal(vibration), decimal(power), decimal(tension), decimal(nozzle), decimal(feedRate), decimal(ph), decimal(density), decimal(particleSize), decimal(catalyst), decimal(recirculation), decimal(coolingFlow), decimal(humiditySetpoint), decimal(priorDefects), decimal(lineLoad), decimal(supplierQuality), decimal(calibration, 4), team, material, decimal(yieldPct, 3)]);
  }
  return rows;
}

async function main() {
  await mkdir(output, { recursive: true });
  await writeSplit("vehicle-resale", ["listing_month", "vehicle_age_years", "mileage_km", "engine_power_kw", "owners_count", "service_history_score", "accident_count", "battery_health_pct", "fuel_price_index", "regional_income_index", "interest_rate_pct", "make", "body_style", "seller_type", "resale_price_eur"], vehicleResaleRows());
  await writeSplit("retail-demand", ["day_index", "day_of_week", "is_holiday", "is_weekend", "base_price_eur", "discount_pct", "has_display", "stock_on_hand", "competitor_price_eur", "temperature_c", "rain_mm", "local_income_index", "store_format", "product_category", "local_event", "units_sold"], retailDemandRows());
  await writeSplit("last-mile-delivery", ["day_index", "hour", "is_weekend", "is_holiday", "distance_km", "traffic_index", "rain_mm", "temperature_c", "parcels_on_route", "driver_experience_months", "pickup_queue_min", "zone_density", "delivery_zone", "service_level", "incident_type", "actual_duration_min"], lastMileDeliveryRows());
  await writeSplit("industrial-yield", ["batch_index", "shift", "line_speed_mpm", "mixer_rpm", "oven_temp_c", "cooling_temp_c", "pressure_bar", "viscosity_pa_s", "moisture_pct", "raw_material_purity_pct", "ambient_temp_c", "ambient_humidity_pct", "machine_wear_hours", "operator_tenure_months", "maintenance_days_since", "vibration_mm_s", "power_kw", "belt_tension_n", "nozzle_diameter_mm", "feed_rate_kg_h", "ph", "density_kg_m3", "particle_size_um", "catalyst_ratio_pct", "recirculation_pct", "cooling_flow_l_min", "humidity_setpoint_pct", "defect_rate_prev_pct", "line_load_pct", "supplier_quality_index", "calibration_offset", "operator_team", "material_family", "yield_pct"], industrialYieldRows());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
