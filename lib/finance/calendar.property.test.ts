import { describe, expect, it } from "vitest";
import { checkProperty, fc } from "@/lib/property-check";
import { calendarDate, calendarDayBoundary, reviewedLocalTimestamp } from "./calendar";
import { defined } from "@/lib/testing";

const HOUR = 3_600_000;
const zones = fc.constantFrom("UTC", "Europe/Amsterdam", "America/New_York", "America/St_Johns", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Auckland");
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const day = (year: number, month: number, date: number) => Date.UTC(year, month - 1, date);
const nextDay = (date: string) => iso(Date.parse(`${date}T00:00:00Z`) + 24 * HOUR);
const previousDay = (date: string) => iso(Date.parse(`${date}T00:00:00Z`) - 24 * HOUR);
const dates = fc.integer({ min: day(2000, 1, 1) / (24 * HOUR), max: day(2040, 12, 31) / (24 * HOUR) }).map(days => iso(days * 24 * HOUR));
const years = fc.integer({ min: 2007, max: 2037 });

function sundays(year: number, month: number) {
  const found: number[] = [];
  for (let date = new Date(day(year, month, 1)); date.getUTCMonth() === month - 1; date = new Date(date.getTime() + 24 * HOUR)) if (date.getUTCDay() === 0) found.push(date.getUTCDate());
  return found;
}
const pad = (value: number) => String(value).padStart(2, "0");

describe("calendar days in an explicit time zone", () => {
  it("a day starts exactly where the previous one ends, for every zone including leap days", () => {
    checkProperty("day boundaries partition time", fc.property(dates, zones, (date, zone) => {
      const start = Date.parse(calendarDayBoundary(date, zone));
      expect(calendarDate(new Date(start), zone)).toBe(date);
      expect(calendarDate(new Date(start - 1), zone)).toBe(previousDay(date));
      const length = Date.parse(calendarDayBoundary(nextDay(date), zone)) - start;
      expect(Math.abs(length - 24 * HOUR)).toBeLessThanOrEqual(HOUR);
      expect(length % (30 * 60_000)).toBe(0);
    }));
  });

  it("every instant falls inside the day it is dated to", () => {
    const instants = fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2040-12-31T23:59:59Z"), noInvalidDate: true });
    checkProperty("instants fall in their day", fc.property(instants, zones, (instant, zone) => {
      const date = calendarDate(instant, zone);
      expect(Date.parse(calendarDayBoundary(date, zone))).toBeLessThanOrEqual(instant.getTime());
      expect(instant.getTime()).toBeLessThan(Date.parse(calendarDayBoundary(nextDay(date), zone)));
    }));
  });

  it("a year lasts 365 days, or 366 in a leap year, with one short and one long day where clocks change", () => {
    const dstZones = fc.constantFrom("Europe/Amsterdam", "America/New_York");
    checkProperty("years keep their length across daylight saving", fc.property(years, dstZones, (year, zone) => {
      const start = Date.parse(calendarDayBoundary(`${year}-01-01`, zone));
      expect(Date.parse(calendarDayBoundary(`${year + 1}-01-01`, zone)) - start).toBe((isLeap(year) ? 366 : 365) * 24 * HOUR);
      const starts: number[] = [];
      for (let ms = day(year, 1, 1); ms <= day(year + 1, 1, 1); ms += 24 * HOUR) starts.push(Date.parse(calendarDayBoundary(iso(ms), zone)));
      const lengths = starts.slice(1).map((end, index) => end - defined(starts[index]));
      expect(lengths.filter(length => length === 23 * HOUR)).toHaveLength(1);
      expect(lengths.filter(length => length === 25 * HOUR)).toHaveLength(1);
      expect(lengths).toHaveLength(isLeap(year) ? 366 : 365);
    }), 20);
  });

  it("the leap day exists only in leap years and adds exactly one day between February and March", () => {
    checkProperty("leap days", fc.property(fc.integer({ min: 1996, max: 2044 }), zones, (year, zone) => {
      const feb28 = Date.parse(calendarDayBoundary(`${year}-02-28`, zone));
      const mar1 = Date.parse(calendarDayBoundary(`${year}-03-01`, zone));
      expect(mar1 - feb28).toBe((isLeap(year) ? 2 : 1) * 24 * HOUR);
      if (isLeap(year)) expect(calendarDate(new Date(mar1 - 1), zone)).toBe(`${year}-02-29`);
      else expect(() => reviewedLocalTimestamp(`${year}-02-29T12:00:00`, zone)).toThrow("Invalid local timestamp");
    }));
  });

  it("wall clock times that never happen or happen twice are refused, not guessed", () => {
    checkProperty("clock changes are never guessed", fc.property(years, year => {
      const newYorkSpring = defined(sundays(year, 3)[1]);
      const newYorkAutumn = defined(sundays(year, 11)[0]);
      const amsterdamSpring = defined(sundays(year, 3).at(-1));
      const amsterdamAutumn = defined(sundays(year, 10).at(-1));
      expect(() => reviewedLocalTimestamp(`${year}-03-${pad(newYorkSpring)}T02:30:00`, "America/New_York")).toThrow("ambiguous or nonexistent");
      expect(() => reviewedLocalTimestamp(`${year}-11-${pad(newYorkAutumn)}T01:30:00`, "America/New_York")).toThrow("ambiguous or nonexistent");
      expect(() => reviewedLocalTimestamp(`${year}-03-${pad(amsterdamSpring)}T02:30:00`, "Europe/Amsterdam")).toThrow("ambiguous or nonexistent");
      expect(() => reviewedLocalTimestamp(`${year}-10-${pad(amsterdamAutumn)}T02:30:00`, "Europe/Amsterdam")).toThrow("ambiguous or nonexistent");
      const noonBefore = Date.parse(reviewedLocalTimestamp(`${year}-03-${pad(newYorkSpring)}T12:00:00`, "America/New_York"));
      const noonAfter = Date.parse(reviewedLocalTimestamp(`${year}-03-${pad(newYorkSpring + 1)}T12:00:00`, "America/New_York"));
      expect(noonAfter - noonBefore).toBe(24 * HOUR);
    }));
  });
});
