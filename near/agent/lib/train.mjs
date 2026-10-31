// Least-squares linear regression, the same method as the base project's runner (src/lib/tee/train.ts):
// normal equations with a tiny ridge, Gauss-Jordan inversion, R², RMSE and MAE on the training rows.
// The target is the last column; non-numeric and excluded columns are not features.
const RIDGE = 1e-8;

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.trim());
  return { header, rows: lines.slice(1).map((l) => l.split(',')) };
}

function invert(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    if (Math.abs(p) < 1e-12) throw new Error('singular matrix');
    for (let j = 0; j < 2 * n; j++) a[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

export function trainLinearRegression(csvText, { exclude = [] } = {}) {
  const { header, rows } = parseCsv(csvText);
  const targetIdx = header.length - 1;
  const numeric = (i) => rows.every((r) => r[i] !== '' && Number.isFinite(Number(r[i])));
  const featureIdx = header.map((_, i) => i).filter((i) => i !== targetIdx && !exclude.includes(header[i]) && numeric(i));
  const k = featureIdx.length + 1;
  const xtx = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? RIDGE : 0)));
  const xty = Array(k).fill(0);
  const xs = rows.map((r) => [1, ...featureIdx.map((i) => Number(r[i]))]);
  const ys = rows.map((r) => Number(r[targetIdx]));
  xs.forEach((x, n) => {
    for (let i = 0; i < k; i++) {
      xty[i] += x[i] * ys[n];
      for (let j = 0; j < k; j++) xtx[i][j] += x[i] * x[j];
    }
  });
  const coefficients = invert(xtx).map((row) => row.reduce((s, v, i) => s + v * xty[i], 0));
  const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
  let ssr = 0, sst = 0, abs = 0;
  xs.forEach((x, n) => {
    const p = x.reduce((s, v, i) => s + v * coefficients[i], 0);
    ssr += (ys[n] - p) ** 2;
    sst += (ys[n] - mean) ** 2;
    abs += Math.abs(ys[n] - p);
  });
  const round = (v) => Number(v.toPrecision(10));
  return {
    algo: 'linear_regression',
    version: '1.0.0',
    target: header[targetIdx],
    features: featureIdx.map((i) => header[i]),
    coefficients: coefficients.map(round),
    metrics: { r2: round(sst === 0 ? 0 : 1 - ssr / sst), rmse: round(Math.sqrt(ssr / ys.length)), mae: round(abs / ys.length), n: ys.length },
  };
}
