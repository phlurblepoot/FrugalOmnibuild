import { describe, it, expect } from 'vitest';
import { clearWhitePixels, dataUrlToBlob } from './removeWhiteBackground';

const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());

describe('clearWhitePixels', () => {
  it('makes paper white transparent, keeps ink, and fades light greys', () => {
    const d = px([255, 255, 255, 255], [230, 240, 235, 255], [20, 30, 90, 255], [195, 195, 195, 255], [180, 250, 250, 200]);
    clearWhitePixels(d);
    expect(d[3]).toBe(0);                          // white paper
    expect(d[7]).toBe(0);                          // off-white paper
    expect(d[11]).toBe(255);                       // dark ink untouched
    expect(d[15]).toBe(Math.round(255 * 25 / 50)); // grey edge half-faded
    expect(d[19]).toBe(Math.round(200 * 40 / 50)); // judged by its darkest channel
    expect([...d.slice(0, 3)]).toEqual([255, 255, 255]); // colour channels untouched
  });
});

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL with its type', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,' + btoa('hello'));
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('hello');
  });
});
