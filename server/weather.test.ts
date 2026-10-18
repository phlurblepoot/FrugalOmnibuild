// server/weather.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { conditionForCode, summarize, geocodeAddress, fetchDailyWeather, isStartTime } from './weather';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('conditionForCode', () => {
  it('maps known WMO codes', () => {
    expect(conditionForCode(0)).toBe('Clear');
    expect(conditionForCode(2)).toBe('Partly cloudy');
    expect(conditionForCode(63)).toBe('Rain');
    expect(conditionForCode(95)).toBe('Thunderstorm');
  });
  it('returns em dash for undefined/unknown codes', () => {
    expect(conditionForCode(undefined)).toBe('—');
    expect(conditionForCode(null)).toBe('—');
    expect(conditionForCode(12345)).toBe('—');
  });
});

describe('summarize', () => {
  it('picks the most frequent condition (ties: first seen)', () => {
    const hourly = [
      { hour: '6 AM', tempF: 60, condition: 'Clear' },
      { hour: '7 AM', tempF: 62, condition: 'Clear' },
      { hour: '8 AM', tempF: 64, condition: 'Rain' },
    ];
    expect(summarize(hourly).summary).toBe('Clear');
  });
  it('computes temperature range from min/max, rounding', () => {
    const hourly = [
      { hour: '6 AM', tempF: 58, condition: 'Clear' },
      { hour: '7 AM', tempF: 74, condition: 'Clear' },
      { hour: '8 AM', tempF: 65, condition: 'Clear' },
    ];
    expect(summarize(hourly).temperature).toBe('58–74°F');
  });
  it('returns empty temperature when all temps are null', () => {
    const hourly = [
      { hour: '6 AM', tempF: null, condition: 'Clear' },
      { hour: '7 AM', tempF: null, condition: 'Rain' },
    ];
    expect(summarize(hourly).temperature).toBe('');
  });
  it('returns empty summary/temperature for an empty array', () => {
    expect(summarize([])).toEqual({ summary: '', temperature: '' });
  });
});

describe('geocodeAddress', () => {
  it('returns lat/lon parsed from a mocked Nominatim response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '26.0521', lon: '-80.1425' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await geocodeAddress('123 Main St, Dunmore Heights, FL');
    expect(result).toEqual({ lat: 26.0521, lon: -80.1425 });
  });

  it('sends a User-Agent header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '26.0521', lon: '-80.1425' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    await geocodeAddress('456 Oak Ave');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
  });

  it('returns null on empty array response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await geocodeAddress('nowhere at all');
    expect(result).toBeNull();
  });

  it('returns null when res.ok is false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await geocodeAddress('bad address');
    expect(result).toBeNull();
  });

  it('does not cache a transient (!ok) failure — a later successful call still hits fetch and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ lat: '1', lon: '2' }] });
    vi.stubGlobal('fetch', fetchMock);
    const uniqueAddress = `retry-after-failure-${Math.random()}`;
    const first = await geocodeAddress(uniqueAddress);
    expect(first).toBeNull();
    const second = await geocodeAddress(uniqueAddress);
    expect(second).toEqual({ lat: 1, lon: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches by address and does not hit fetch again for a repeat call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '10', lon: '20' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const uniqueAddress = `789 Cache Test Blvd ${Math.random()}`;
    const first = await geocodeAddress(uniqueAddress);
    const second = await geocodeAddress(uniqueAddress);
    expect(first).toEqual({ lat: 10, lon: 20 });
    expect(second).toEqual({ lat: 10, lon: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('isStartTime', () => {
  it('accepts HH:MM from 00:00 to 23:59 only', () => {
    for (const ok of ['00:00', '06:00', '07:30', '12:00', '23:59']) expect(isStartTime(ok), ok).toBe(true);
    for (const bad of ['7:00', '24:00', '12:60', '0700', '07:00:00', 'noon', '', null, undefined, 700]) {
      expect(isStartTime(bad), String(bad)).toBe(false);
    }
  });
});

describe('fetchDailyWeather', () => {
  // A full-day hourly series (00:00 through 23:00) for each date given: the
  // first day reads 50+h°, each later day carries on from there (74+h°…), and
  // the code alternates Clear/Rain by hour.
  function mockMeteoPayload(dates: string[] = ['2026-08-20']) {
    const time: string[] = [];
    const temperature_2m: number[] = [];
    const weather_code: number[] = [];
    dates.forEach((date, d) => {
      for (let h = 0; h < 24; h++) {
        const hh = String(h).padStart(2, '0');
        time.push(`${date}T${hh}:00`);
        temperature_2m.push(50 + d * 24 + h);
        weather_code.push(h % 2 === 0 ? 0 : 63);
      }
    });
    return { hourly: { time, temperature_2m, weather_code } };
  }

  it('returns only the 6 AM-6 PM rows with correct hour labels and rounded temps', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20');
    expect(result.hourly).toHaveLength(13); // 6..18 inclusive
    expect(result.hourly[0]).toEqual({ hour: '6 AM', tempF: 56, condition: 'Clear' });
    expect(result.hourly[6]).toEqual({ hour: '12 PM', tempF: 62, condition: 'Clear' });
    expect(result.hourly[7]).toEqual({ hour: '1 PM', tempF: 63, condition: 'Rain' });
    expect(result.hourly[12]).toEqual({ hour: '6 PM', tempF: 68, condition: 'Clear' });
  });

  it('the default start (06:00) is exactly the old window: one day requested, the same 13 rows and summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const byDefault = await fetchDailyWeather(26.05, -80.14, '2026-08-20');
    const explicit = await fetchDailyWeather(26.05, -80.14, '2026-08-20', '06:00');
    expect(explicit).toEqual(byDefault);
    expect(byDefault.hourly.map(h => h.hour)).toEqual([
      '6 AM', '7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM',
    ]);
    expect(byDefault.temperature).toBe('56–68°F');
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('start_date=2026-08-20&end_date=2026-08-20');
  });

  it('covers the start hour through 12 hours later, dropping the minutes, and summarizes only that window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20', '07:30');
    expect(result.hourly).toHaveLength(13); // 7..19 inclusive
    expect(result.hourly[0]).toEqual({ hour: '7 AM', tempF: 57, condition: 'Rain' });
    expect(result.hourly[12]).toEqual({ hour: '7 PM', tempF: 69, condition: 'Rain' });
    expect(result.temperature).toBe('57–69°F');
    expect(result.summary).toBe('Rain'); // 7 odd hours of 13
    expect(fetchMock.mock.calls[0][0]).toContain('start_date=2026-08-20&end_date=2026-08-20');
  });

  it('a window ending at 11 PM stays on the one day', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20', '11:00');
    expect(fetchMock.mock.calls[0][0]).toContain('end_date=2026-08-20');
    expect(result.hourly.map(h => h.hour).slice(-1)).toEqual(['11 PM']);
    expect(result.hourly).toHaveLength(13);
  });

  it('runs past midnight into the next day, requesting both days and marking next-day hours +1', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload(['2026-08-20', '2026-08-21']) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20', '18:00');
    expect(fetchMock.mock.calls[0][0]).toContain('start_date=2026-08-20&end_date=2026-08-21');
    expect(result.hourly.map(h => h.hour)).toEqual([
      '6 PM', '7 PM', '8 PM', '9 PM', '10 PM', '11 PM',
      '12 AM +1', '1 AM +1', '2 AM +1', '3 AM +1', '4 AM +1', '5 AM +1', '6 AM +1',
    ]);
    // Day one's 6 PM is 50+18; the next day's 6 AM is 74+6.
    expect(result.hourly[0]).toEqual({ hour: '6 PM', tempF: 68, condition: 'Clear' });
    expect(result.hourly[6]).toEqual({ hour: '12 AM +1', tempF: 74, condition: 'Clear' });
    expect(result.hourly[12]).toEqual({ hour: '6 AM +1', tempF: 80, condition: 'Clear' });
    expect(result.temperature).toBe('68–80°F');
  });

  it('a midnight start covers 12 AM to 12 PM of the report date', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20', '00:00');
    expect(result.hourly.map(h => h.hour)).toEqual([
      '12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '5 AM', '6 AM', '7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM',
    ]);
  });

  it('crosses a month and year end for the next day', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload(['2026-12-31', '2027-01-01']) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-12-31', '23:00');
    expect(fetchMock.mock.calls[0][0]).toContain('start_date=2026-12-31&end_date=2027-01-01');
    expect(result.hourly[0].hour).toBe('11 PM');
    expect(result.hourly[12].hour).toBe('11 AM +1');
    expect(result.hourly).toHaveLength(13);
  });

  it('tolerates the legacy weathercode key', async () => {
    const payload = mockMeteoPayload() as any;
    payload.hourly.weathercode = payload.hourly.weather_code;
    delete payload.hourly.weather_code;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchDailyWeather(26.05, -80.14, '2026-08-20');
    expect(result.hourly[0].condition).toBe('Clear');
  });

  it('picks the archive host for a date >= 8 days ago, with no past_days param', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await fetchDailyWeather(26.05, -80.14, old);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('archive-api.open-meteo.com');
    expect(calledUrl).not.toContain('past_days');
  });

  it('picks the forecast host for a recent date, with no past_days param', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
    vi.stubGlobal('fetch', fetchMock);
    const recent = new Date().toISOString().slice(0, 10);
    await fetchDailyWeather(26.05, -80.14, recent);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('api.open-meteo.com');
    expect(calledUrl).not.toContain('archive-api');
    // Open-Meteo rejects past_days when start_date/end_date are present
    // (HTTP 400 "mutually exclusive") — verified live against the real API.
    expect(calledUrl).not.toContain('past_days');
  });

  // The archive lags real time, so a window reaching into the next day picks
  // its host by that NEWER day. Only Date is faked: the request's timeout
  // timer stays real.
  describe('host choice for a window that runs into the next day', () => {
    const hostFor = async (date: string, start: string) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockMeteoPayload() });
      vi.stubGlobal('fetch', fetchMock);
      await fetchDailyWeather(26.05, -80.14, date, start);
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      return calledUrl.includes('archive-api.open-meteo.com') ? 'archive' : 'forecast';
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 8, 28, 12)); // Sept 28, 2026, local noon
    });

    it('a date 8 days ago is archive on its own, but forecast when its window ends 7 days ago', async () => {
      expect(await hostFor('2026-09-20', '06:00')).toBe('archive');
      expect(await hostFor('2026-09-20', '18:00')).toBe('forecast');
    });

    it('stays on the archive when both days are old enough', async () => {
      expect(await hostFor('2026-09-19', '18:00')).toBe('archive');
    });

    it('uses the forecast host for yesterday into today', async () => {
      expect(await hostFor('2026-09-27', '20:00')).toBe('forecast');
    });
  });
});
