export type MarketStatus = 'open' | 'pre-market' | 'after-hours' | 'closed';

/** Returns current time components in US Eastern Time using the system's IANA support. */
function etNow(): { day: number; totalMinutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric',
    weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
  const hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);
  return { day, totalMinutes: hour * 60 + minute };
}

export function getMarketStatus(): MarketStatus {
  const { day, totalMinutes } = etNow();
  if (day === 0 || day === 6) return 'closed';           // weekend
  if (totalMinutes < 4 * 60)        return 'closed';      // before 4 AM
  if (totalMinutes < 9 * 60 + 30)   return 'pre-market';  // 4:00–9:29 AM
  if (totalMinutes < 16 * 60)       return 'open';        // 9:30 AM–3:59 PM
  if (totalMinutes < 20 * 60)       return 'after-hours'; // 4:00–7:59 PM
  return 'closed';
}

export function isMarketOpen(): boolean {
  return getMarketStatus() === 'open';
}

/** Minutes until regular market open (0 if already open or past close). */
export function minutesUntilOpen(): number {
  const { day, totalMinutes } = etNow();
  if (day === 0 || day === 6) return -1;   // weekend — not calculable simply
  const openMinutes = 9 * 60 + 30;
  if (totalMinutes >= openMinutes && totalMinutes < 16 * 60) return 0;
  if (totalMinutes < openMinutes) return openMinutes - totalMinutes;
  return -1;  // past close for today
}

/** Minutes until regular market close (negative if already closed or weekend). */
export function minutesUntilClose(): number {
  const { day, totalMinutes } = etNow();
  if (day === 0 || day === 6) return -1;
  return 16 * 60 - totalMinutes;
}
