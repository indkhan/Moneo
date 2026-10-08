import type {recurringCadences} from "../lib/finance/cadences";

type Cadence = typeof recurringCadences[number];
function calendarOffset(date: string, months: number, days: number) {
  const start = new Date(`${date}T00:00:00Z`);
  if (months) {
    const shifted = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+months,1));
    const last = new Date(Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth()+1,0)).getUTCDate();
    shifted.setUTCDate(Math.min(start.getUTCDate(),last));
    return shifted.toISOString().slice(0,10);
  }
  start.setUTCDate(start.getUTCDate()+days);
  return start.toISOString().slice(0,10);
}
// Extracted fixture arithmetic: the submitted occurrence must follow generated
// dates, including when reverse month arithmetic clamps the original day.
export function recurringFixtureCalendar(today: string, cadence: Cadence, paidEarly = false) {
  const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : cadence === "yearly" ? 12 : 0;
  const days = cadence === "weekly" ? 7 : cadence === "biweekly" ? 14 : 0;
  const tolerance = cadence === "yearly" ? 7 : months ? 4 : 2;
  const requestedLatest = calendarOffset(today,0,paidEarly ? tolerance : -1);
  const anchor = calendarOffset(requestedLatest,-2*months,-2*days);
  const dates = Array.from({length:3},(_,index)=>calendarOffset(anchor,months*index,days*index));
  return {today,anchor,dates,latest:dates[2],postedLatest:paidEarly ? today : dates[2],next:calendarOffset(anchor,months*3,days*3),months,days};
}
