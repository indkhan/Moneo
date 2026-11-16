import fc from "fast-check";
import regressions from "./property-regressions.json";

const SEED = Number(process.env.PROPERTY_SEED ?? 242);
const RUNS = Number(process.env.PROPERTY_RUNS ?? 200);

type Replay = { seed: number; path: string };

export function checkProperty<T>(name: string, property: fc.IPropertyWithHooks<T>, runs = RUNS) {
  const replays: Replay[] = (regressions as Record<string, Replay[]>)[name] ?? [];
  for (const replay of replays) fc.assert(property, { seed: replay.seed, path: replay.path, endOnFailure: true });
  try {
    fc.assert(property, { seed: SEED, numRuns: runs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n\nTo keep this failure as a permanent check, add its seed and path to lib/property-regressions.json under "${name}".`);
  }
}

export { fc };
