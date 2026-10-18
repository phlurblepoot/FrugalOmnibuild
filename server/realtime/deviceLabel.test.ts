import { describe, it, expect } from 'vitest';
import { deviceLabel } from './deviceLabel';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  iPad: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

describe('deviceLabel', () => {
  it('labels Windows Chrome', () => expect(deviceLabel(UA.winChrome)).toBe('Windows · Chrome'));
  it('labels Edge before Chrome (Edge UA contains "Chrome")', () => expect(deviceLabel(UA.winEdge)).toBe('Windows · Edge'));
  it('labels Mac Safari (Safari UA contains no "Chrome")', () => expect(deviceLabel(UA.macSafari)).toBe('Mac · Safari'));
  it('labels iPad', () => expect(deviceLabel(UA.iPad)).toBe('iPad · Safari'));
  it('labels iPhone', () => expect(deviceLabel(UA.iPhone)).toBe('iPhone · Safari'));
  it('labels Android Chrome', () => expect(deviceLabel(UA.android)).toBe('Android · Chrome'));
  it('labels Linux Firefox', () => expect(deviceLabel(UA.linuxFirefox)).toBe('Linux · Firefox'));
  it('handles missing UA', () => expect(deviceLabel(undefined)).toBe('Unknown device'));
});
