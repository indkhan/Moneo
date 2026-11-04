import { formatMoney } from "./finance/format";

const calendarDay = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one way to show dates and money, from the workspace's locale and timezone. Safe in server and client components.
 * A plain YYYY-MM-DD is a calendar day and never shifts with the timezone; a timestamp is shown in the workspace's timezone.
 */
export function displayFormat(locale: string, timeZone = "UTC") {
  const formatter = (options: Intl.DateTimeFormatOptions) => (value: string) => {
    const day = calendarDay.test(value);
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: day ? "UTC" : timeZone }).format(new Date(day ? `${value}T00:00:00Z` : value));
  };
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return {
    money: (amountMinor: bigint | string | number, currency: string) => formatMoney(amountMinor, currency, locale),
    /** 4 Nov 2026 */
    date: formatter({ day: "numeric", month: "short", year: "numeric" }),
    /** 4 November 2026 */
    longDate: formatter({ day: "numeric", month: "long", year: "numeric" }),
    /** 4 Nov */
    dayMonth: formatter({ day: "numeric", month: "short" }),
    /** Nov 2026 */
    monthYear: formatter({ month: "short", year: "numeric" }),
    /** Nov */
    shortMonth: formatter({ month: "short" }),
    /** November */
    month: formatter({ month: "long" }),
    /** Wednesday */
    weekday: formatter({ weekday: "long" }),
    /** 4 Nov 2026, 17:23 */
    dateTime: formatter({ day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    /** 5 minutes ago, yesterday; `now` is passed in so server and client agree. */
    ago: (value: string, now: string) => {
      const minutes = Math.max(Math.round((Date.parse(now) - Date.parse(value)) / 60000), 0);
      return minutes < 60 ? relative.format(-minutes, "minute") : minutes < 1440 ? relative.format(-Math.round(minutes / 60), "hour") : relative.format(-Math.round(minutes / 1440), "day");
    },
  };
}
