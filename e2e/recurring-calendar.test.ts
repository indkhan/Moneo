import {expect,it} from "vitest";
import {recurringFixtureCalendar} from "./recurring-calendar";
it.each([
  {today:"2026-05-01",cadence:"monthly" as const,dates:["2026-02-28","2026-03-28","2026-04-28"],latest:"2026-04-28"},
  {today:"2026-09-01",cadence:"quarterly" as const,dates:["2026-02-28","2026-05-28","2026-08-28"],latest:"2026-08-28"},
  {today:"2028-03-01",cadence:"yearly" as const,dates:["2026-02-28","2027-02-28","2028-02-28"],latest:"2028-02-28"},
  {today:"2026-05-01",cadence:"weekly" as const,dates:["2026-04-16","2026-04-23","2026-04-30"],latest:"2026-04-30"},
  {today:"2026-05-01",cadence:"biweekly" as const,dates:["2026-04-02","2026-04-16","2026-04-30"],latest:"2026-04-30"},
])("uses actual generated $cadence dates for occurrence and counterpart on $today",({today,cadence,dates,latest})=>{
  const fixture=recurringFixtureCalendar(today,cadence);
  expect(fixture.dates).toEqual(dates);
  expect(fixture.latest).toBe(latest);
});
