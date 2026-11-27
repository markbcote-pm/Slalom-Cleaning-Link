// Forecast for the rental from Open-Meteo (free, no key). Cached in meta for 3 hours so a page
// load or an alert doesn't wait on the network every time. Failures just mean no weather line.
const CODES = [
  [[0], 'sunny'], [[1, 2], 'mostly sunny'], [[3], 'cloudy'], [[45, 48], 'foggy'],
  [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], 'rainy'], [[71, 73, 75, 77, 85, 86], 'snowy'], [[95, 96, 99], 'stormy'],
];
export const describeCode = (c) => (CODES.find(([list]) => list.includes(c)) || [0, 'mixed'])[1];

export async function forecast({ db, config, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const lat = config.weatherLat ?? 38.93, lon = config.weatherLon ?? -119.98;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'weather:forecast'").get();
  if (row) { try { const c = JSON.parse(row.value); if (now - c.at < 3 * 3600e3) return c.days; } catch {} }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,snowfall_sum`
      + `&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=${encodeURIComponent(config.timezone)}&forecast_days=16`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const d = (await res.json()).daily;
    const days = Object.fromEntries(d.time.map((t, i) => [t, { code: d.weather_code[i], hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), snow: Math.round((d.snowfall_sum[i] || 0) * 10) / 10 }]));
    db.prepare("INSERT INTO meta (key, value) VALUES ('weather:forecast', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ at: now, days }));
    return days;
  } catch (e) {
    if (row) { try { return JSON.parse(row.value).days; } catch {} }
    return null;
  }
}
