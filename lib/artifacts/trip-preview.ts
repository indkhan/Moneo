// The sandbox receives only the returned host snapshot; it never fetches or executes financial logic itself.
export async function refreshTripSnapshot(snapshot: unknown, params: Record<string, string | number>, artifactId: string, signal: AbortSignal): Promise<unknown> {
  const record = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
  const forecast = record.forecast && typeof record.forecast === "object" ? record.forecast as Record<string, unknown> : record;
  const result = forecast.tripResult && typeof forecast.tripResult === "object" ? forecast.tripResult as Record<string, unknown> : {};
  const response = await fetch("/api/artifacts/trip", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifactId, params, ...(result.scenario ? { baseScenario: result.scenario } : {}) }), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Dated trip preview unavailable");
  return data;
}
