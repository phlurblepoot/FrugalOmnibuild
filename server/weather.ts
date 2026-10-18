// server/weather.ts
// Daily observed weather for daily reports. Server-side so plain-LAN clients
// need no internet. Free/no-key providers: OSM Nominatim (geocode, usage
// policy requires a UA header) + Open-Meteo (hourly observed temps/conditions).

export interface DailyWeatherResult {
  hourly: { hour: string; tempF: number | null; condition: string }[];
  summary: string;
  temperature: string;
}

const geocodeCache = new Map<string, { lat: number; lon: number } | null>();

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  56: 'Frz drizzle', 57: 'Frz drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Frz rain', 67: 'Frz rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

export const conditionForCode = (code: number | null | undefined): string =>
  code == null ? '—' : (WMO[code] ?? '—');

export function summarize(hourly: DailyWeatherResult['hourly']): { summary: string; temperature: string } {
  if (hourly.length === 0) return { summary: '', temperature: '' };

  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const h of hourly) {
    if (h.condition === '—') continue;
    if (!counts.has(h.condition)) { counts.set(h.condition, 0); order.push(h.condition); }
    counts.set(h.condition, counts.get(h.condition)! + 1);
  }
  let summary = '';
  let best = -1;
  for (const cond of order) {
    const c = counts.get(cond)!;
    if (c > best) { best = c; summary = cond; }
  }

  const temps = hourly.map(h => h.tempF).filter((t): t is number => t != null);
  const temperature = temps.length === 0 ? '' : `${Math.min(...temps)}–${Math.max(...temps)}°F`;

  return { summary, temperature };
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  if (geocodeCache.has(address)) return geocodeCache.get(address)!;

  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FrugalOmnibuild/2.7 (daily-report weather)' },
    signal: AbortSignal.timeout(10_000),
  });
  // A transient !ok (e.g. Nominatim 429/503) must NOT be cached — that would
  // permanently poison this address until restart, with no way to recover via
  // "Refresh weather". Only a genuinely bad address (ok but empty results) is
  // cacheable.
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) { geocodeCache.set(address, null); return null; }

  const result = { lat: Number(data[0].lat), lon: Number(data[0].lon) };
  geocodeCache.set(address, result);
  return result;
}

// A daily report's start time: 'HH:MM', 24-hour. The weather covers the start
// hour (minutes dropped) through WINDOW_HOURS later, inclusive — 13 hourly
// readings. The default start reproduces the original fixed 6 AM–6 PM window,
// which is also what a report with no start time (made before migration 44)
// was fetched for.
export const DEFAULT_START_TIME = '06:00';
export const WINDOW_HOURS = 12;
export const isStartTime = (v: unknown): v is string =>
  typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// `h` counts from midnight of the report date; 24+ is the next day, marked
// "+1" so a window that runs past midnight never shows two "6 AM"s.
function hourLabel(h: number): string {
  const next = h >= 24 ? ' +1' : '';
  const hh = h % 24;
  if (hh === 0) return `12 AM${next}`;
  if (hh === 12) return `12 PM${next}`;
  if (hh > 12) return `${hh - 12} PM${next}`;
  return `${hh} AM${next}`;
}

const nextDay = (date: string): string => {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const daysAgo = (date: string): number =>
  Math.floor((Date.now() - new Date(date + 'T12:00:00').getTime()) / 86_400_000);

export async function fetchDailyWeather(lat: number, lon: number, date: string, startTime: string = DEFAULT_START_TIME): Promise<DailyWeatherResult> {
  const startHour = Number(startTime.slice(0, 2));
  const endHour = startHour + WINDOW_HOURS; // past 23 = into the next day
  const endDate = endHour > 23 ? nextDay(date) : date;
  // The archive lags real time by several days, so the host is picked by the
  // NEWEST day the window touches: a window that ends in the last week goes
  // to the forecast host, which serves the recent past as well.
  const isArchive = daysAgo(endDate) >= 8;
  const host = isArchive ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  // Open-Meteo rejects `past_days` when start_date/end_date are present
  // ("mutually exclusive"), and both hosts serve any date (recent or old)
  // fine without it — so it's never added.
  const url = `${host}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${endDate}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo request failed: ${res.status}`);
  const data = await res.json();

  const codes: (number | null)[] = data.hourly.weather_code ?? data.hourly.weathercode ?? [];
  const hourly: DailyWeatherResult['hourly'] = [];
  for (let i = 0; i < data.hourly.time.length; i++) {
    const t: string = data.hourly.time[i];
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):00$/.exec(t);
    if (!match) continue;
    const day = match[1] === date ? 0 : match[1] === endDate ? 1 : -1;
    if (day < 0) continue;
    const h = day * 24 + Number(match[2]);
    if (h < startHour || h > endHour) continue;
    const temp = data.hourly.temperature_2m[i];
    hourly.push({
      hour: hourLabel(h),
      tempF: temp == null ? null : Math.round(temp),
      condition: conditionForCode(codes[i]),
    });
  }

  return { hourly, ...summarize(hourly) };
}
