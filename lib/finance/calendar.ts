export function datePart(parts: Intl.DateTimeFormatPart[], type: string): string {
  const part = parts.find(item => item.type === type);
  if (!part) throw new Error(`The formatted date has no ${type}`);
  return part.value;
}

export function calendarDate(value: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(value));
  return `${datePart(parts, "year")}-${datePart(parts, "month")}-${datePart(parts, "day")}`;
}

export function reviewedLocalTimestamp(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error("Invalid local timestamp");
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  const checked = new Date(wall);
  if (checked.getUTCFullYear() !== Number(match[1]) || checked.getUTCMonth() + 1 !== Number(match[2]) || checked.getUTCDate() !== Number(match[3]) ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) throw new Error("Invalid local timestamp");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const localWall = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (key: string) => Number(datePart(parts, key));
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  };
  const candidates = new Set<number>();
  for (const probe of [wall - 86400000, wall, wall + 86400000]) {
    const candidate = wall - (localWall(probe) - probe);
    if (localWall(candidate) === wall) candidates.add(candidate);
  }
  const [instant] = candidates;
  if (candidates.size !== 1 || instant === undefined) throw new Error("Source timestamp is ambiguous or nonexistent in the reviewed timezone");
  return new Date(instant + Number((match[7] ?? "").padEnd(3, "0"))).toISOString();
}

export function calendarDayBoundary(date: string, timeZone: string): string {
  return reviewedLocalTimestamp(`${date}T00:00:00`, timeZone);
}
