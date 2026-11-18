export function defined<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what} to be present`);
  return value;
}
