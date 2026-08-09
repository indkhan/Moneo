export function dashboardHeader(date = new Date(), locale, timeZone) {
  const hour = Number(new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).format(date));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    timeZone,
  }).format(date);
  const day = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(date);
  return {
    title: greeting,
    subtitle: `${weekday}, ${day} · your local view is ready`,
  };
}
