const MAX_OUTPUT_CHARS = 20_000;

function isPlainJson(value: unknown, depth = 0): string | null {
  if (depth > 4) return "output is nested too deeply (max 4)";
  if (value === null) return null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value) ? null : "output contains a non-finite number";
  if (t === "string" || t === "boolean") return null;
  if (t === "function" || t === "symbol" || t === "undefined")
    return `output contains ${t}, only JSON values are allowed`;
  if (Array.isArray(value)) {
    if (value.length > 50) return "output array has more than 50 items";
    for (const item of value) {
      const err = isPlainJson(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 30) return "output object has more than 30 keys";
    for (const [key, item] of entries) {
      if (key.length > 60) return `output key ${key} is too long`;
      const err = isPlainJson(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  return `output contains ${t}, only JSON values are allowed`;
}

export function checkOutputShape(output: unknown): string[] {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return ["Smoke test must return a JSON object such as { summary, rows }"];
  }
  const errors: string[] = [];
  const json = JSON.stringify(output);
  if (json.length > MAX_OUTPUT_CHARS) {
    errors.push(`Output is too large (${json.length} chars, max ${MAX_OUTPUT_CHARS})`);
  }
  const plain = isPlainJson(output);
  if (plain) errors.push(plain);
  const text = json.toLowerCase();
  if (text.includes("<script") || text.includes("<iframe") || text.includes("javascript:")) {
    errors.push("Output contains forbidden markup");
  }
  const record = output as Record<string, unknown>;
  const hasKnownKey =
    "summary" in record || "rows" in record || "numbers" in record ||
    "chart" in record || "unavailable" in record || "warning" in record;
  if (!hasKnownKey) {
    errors.push("Output must include one of: summary, rows, numbers, chart, unavailable, warning");
  }
  if ("summary" in record && record.summary !== undefined && typeof record.summary !== "string") {
    errors.push("Output summary must be a string");
  }
  if (typeof record.summary === "string" && record.summary.length > 500) {
    errors.push("Output summary is too long (max 500 chars)");
  }
  for (const key of ["unavailable", "warning"]) {
    if (key in record && typeof record[key] !== "string") errors.push(`Output ${key} must be a string`);
  }
  if ("rows" in record && (!Array.isArray(record.rows) || record.rows.some(row =>
    row === null || typeof row !== "object" || Array.isArray(row)))) errors.push("Output rows must be an array of objects");
  if ("numbers" in record && (record.numbers === null || typeof record.numbers !== "object" || Array.isArray(record.numbers) ||
    Object.values(record.numbers).some(value => typeof value !== "string" && typeof value !== "number"))) errors.push("Output numbers must contain strings or finite numbers");
  if ("chart" in record) {
    const chart = record.chart as { labels?: unknown; values?: unknown } | null;
    if (!chart || typeof chart !== "object" || !Array.isArray(chart.labels) || !Array.isArray(chart.values) ||
      chart.labels.some(label => typeof label !== "string") || chart.values.some(value => typeof value !== "number" || !Number.isFinite(value)) ||
      chart.labels.length !== chart.values.length) errors.push("Output chart requires matching labels and finite values");
  }
  return errors;
}
