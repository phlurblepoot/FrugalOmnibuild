import { describe, it, expect } from 'vitest';
import { readOnlyofficeConfig } from './config';

const full = {
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com/',
  ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice//',
  APP_INTERNAL_URL: 'http://app:3000/',
  ONLYOFFICE_JWT_SECRET: '  s3cret  ',
};

describe('readOnlyofficeConfig', () => {
  it('reads all four settings, trimming whitespace and trailing slashes', () => {
    expect(readOnlyofficeConfig(full)).toEqual({
      config: {
        publicUrl: 'https://docs.example.com',
        internalUrl: 'http://onlyoffice',
        appInternalUrl: 'http://app:3000',
        jwtSecret: 's3cret',
      },
      problems: [],
    });
  });

  it('keeps a path prefix when ONLYOFFICE is served under one', () => {
    const r = readOnlyofficeConfig({ ...full, ONLYOFFICE_PUBLIC_URL: 'https://example.com/onlyoffice/' });
    expect(r.config?.publicUrl).toBe('https://example.com/onlyoffice');
  });

  it('defaults the internal URL to the public one, and the app URL to APP_PUBLIC_URL', () => {
    const r = readOnlyofficeConfig({
      ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
      APP_PUBLIC_URL: 'https://takeoff.example.com',
      ONLYOFFICE_JWT_SECRET: 's',
    });
    expect(r.config).toMatchObject({ internalUrl: 'https://docs.example.com', appInternalUrl: 'https://takeoff.example.com' });
  });

  it('names every missing setting and returns no config', () => {
    const r = readOnlyofficeConfig({});
    expect(r.config).toBeNull();
    expect(r.problems.map(p => p.variable)).toEqual(['ONLYOFFICE_PUBLIC_URL', 'APP_INTERNAL_URL', 'ONLYOFFICE_JWT_SECRET']);
  });

  it('rejects addresses that are not http(s), naming the variable that held them', () => {
    const r = readOnlyofficeConfig({ ...full, ONLYOFFICE_INTERNAL_URL: 'onlyoffice:80', APP_INTERNAL_URL: '' , APP_PUBLIC_URL: 'ftp://x' });
    expect(r.config).toBeNull();
    expect(r.problems).toEqual([
      { variable: 'ONLYOFFICE_INTERNAL_URL', problem: expect.stringContaining('onlyoffice:80') },
      { variable: 'APP_PUBLIC_URL', problem: expect.stringContaining('ftp://x') },
    ]);
  });
});
