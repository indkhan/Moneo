import { formatMoney } from "./finance/format";

const calendarDay = /^\d{4}-\d{2}-\d{2}$/;

export function displayFormat(locale: string, timeZone = "UTC") {
  const formatter = (options: Intl.DateTimeFormatOptions) => {
    let dayFormat: Intl.DateTimeFormat | undefined;
    let instantFormat: Intl.DateTimeFormat | undefined;
    return (value: string) => calendarDay.test(value)
      ? (dayFormat ??= new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })).format(new Date(`${value}T00:00:00Z`))
      : (instantFormat ??= new Intl.DateTimeFormat(locale, { ...options, timeZone })).format(new Date(value));
  };
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return {
    money: (amountMinor: bigint | string | number, currency: string) => formatMoney(amountMinor, currency, locale),
    date: formatter({ day: "numeric", month: "short", year: "numeric" }),
    longDate: formatter({ day: "numeric", month: "long", year: "numeric" }),
    dayMonth: formatter({ day: "numeric", month: "short" }),
    monthYear: formatter({ month: "short", year: "numeric" }),
    shortMonth: formatter({ month: "short" }),
    month: formatter({ month: "long" }),
    weekday: formatter({ weekday: "long" }),
    dateTime: formatter({ day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    ago: (value: string, now: string) => {
      const minutes = Math.max(Math.round((Date.parse(now) - Date.parse(value)) / 60000), 0);
      return minutes < 60 ? relative.format(-minutes, "minute") : minutes < 1440 ? relative.format(-Math.round(minutes / 60), "hour") : relative.format(-Math.round(minutes / 1440), "day");
    },
  };
}
