// Pure colour conversion helpers — sRGB hex → OKLCH.
//
// Used to derive an accent HUE from a user-picked hex colour so the custom
// accent can flow through the same fixed lightness/chroma scale as the presets
// (keeping contrast consistent — only hue varies).

export interface Oklch {
  l: number; // perceptual lightness, ~[0,1]
  c: number; // chroma, >= 0
  h: number; // hue in degrees, [0,360)
}

const ACHROMATIC_FALLBACK_HUE = 264; // matches default 'blue' preset

// Parse #rgb / #rrggbb (with or without leading '#') into 0..1 sRGB channels.
// Returns null on malformed input.
function parseHex(hex: string): [number, number, number] | null {
  if (typeof hex !== 'string') return null;
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) {
    s = s
      .split('')
      .map(ch => ch + ch)
      .join('');
  }
  if (s.length !== 6) return null;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  return [r, g, b];
}

// sRGB gamma → linear-light.
function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

// Convert a hex colour to OKLCH. Malformed input falls back to a neutral
// blue-ish achromatic result (l=0, c=0, h=fallback).
export function hexToOklch(hex: string): Oklch {
  const parsed = parseHex(hex);
  if (!parsed) {
    return { l: 0, c: 0, h: ACHROMATIC_FALLBACK_HUE };
  }
  const [sr, sg, sb] = parsed;
  const r = srgbToLinear(sr);
  const g = srgbToLinear(sg);
  const b = srgbToLinear(sb);

  // Linear sRGB → LMS
  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  // Non-linearity
  const lc = Math.cbrt(l_);
  const mc = Math.cbrt(m_);
  const sc = Math.cbrt(s_);

  // LMS → OKLab
  const L = 0.2104542553 * lc + 0.793617785 * mc - 0.0040720468 * sc;
  const a = 1.9779984951 * lc - 2.428592205 * mc + 0.4505937099 * sc;
  const bb = 0.0259040371 * lc + 0.7827717662 * mc - 0.808675766 * sc;

  const C = Math.hypot(a, bb);
  let H: number;
  if (C < 1e-4) {
    H = ACHROMATIC_FALLBACK_HUE;
  } else {
    H = (Math.atan2(bb, a) * 180) / Math.PI;
    H = ((H % 360) + 360) % 360;
  }

  return { l: L, c: C, h: H };
}

// Convenience: derive just the accent hue from a hex colour.
// Achromatic colours (greys/black/white) fall back to the default hue.
export function hexToAccentHue(hex: string): number {
  return hexToOklch(hex).h;
}
