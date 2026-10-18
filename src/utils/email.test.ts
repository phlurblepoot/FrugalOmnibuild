// src/utils/email.test.ts
import { describe, it, expect } from 'vitest';
import { isValidEmail, parseAddressList, isValidAddressList, parseAddresses, formatAddresses, textToHtml } from './email';

describe('isValidEmail', () => {
  it('accepts a valid single address', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('first.last@sub.example.co')).toBe(true);
  });
  it('trims before validating', () => {
    expect(isValidEmail('  a@b.com  ')).toBe(true);
  });
  it('rejects invalid addresses', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('@b.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('   ')).toBe(false);
  });
});

describe('parseAddressList', () => {
  it('splits on commas', () => {
    expect(parseAddressList('a@b.com, c@d.com')).toEqual(['a@b.com', 'c@d.com']);
  });
  it('splits on semicolons', () => {
    expect(parseAddressList('a@b.com; c@d.com')).toEqual(['a@b.com', 'c@d.com']);
  });
  it('splits on a mix of comma and semicolon', () => {
    expect(parseAddressList('a@b.com, c@d.com; e@f.com')).toEqual(['a@b.com', 'c@d.com', 'e@f.com']);
  });
  it('trims entries and drops empties', () => {
    expect(parseAddressList(' a@b.com ,, ; c@d.com ')).toEqual(['a@b.com', 'c@d.com']);
  });
  it('returns [] for blank/whitespace', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
    expect(parseAddressList(' , ; ')).toEqual([]);
  });
});

describe('isValidAddressList', () => {
  it('accepts a valid single address', () => {
    expect(isValidAddressList('a@b.com')).toBe(true);
  });
  it('accepts a valid comma list', () => {
    expect(isValidAddressList('a@b.com, c@d.com')).toBe(true);
  });
  it('accepts a valid semicolon list', () => {
    expect(isValidAddressList('a@b.com; c@d.com')).toBe(true);
  });
  it('returns true for an empty list (optional cc/bcc)', () => {
    expect(isValidAddressList('')).toBe(true);
    expect(isValidAddressList('   ')).toBe(true);
  });
  it('rejects a list with any invalid entry', () => {
    expect(isValidAddressList('a@b.com, nope')).toBe(false);
    expect(isValidAddressList('bad; c@d.com')).toBe(false);
    expect(isValidAddressList('not-an-email')).toBe(false);
  });
});

describe('parseAddresses', () => {
  it('parses a bare address, lowercasing the domain part', () => {
    expect(parseAddresses('Bob@Acme.com')).toEqual([{ addr: 'bob@acme.com' }]);
  });
  it('parses a display name with angle brackets', () => {
    expect(parseAddresses('Bob Jones <bob@acme.com>')).toEqual([{ addr: 'bob@acme.com', name: 'Bob Jones' }]);
    // A quoted name containing a comma is split by the list separator exactly
    // as the server splits it — neither side keeps it whole, so neither invents
    // a recipient the other would not.
    expect(parseAddresses('"Bob" <bob@acme.com>')).toEqual([{ addr: 'bob@acme.com', name: 'Bob' }]);
  });
  it('splits on commas and semicolons and drops unparseable entries', () => {
    expect(parseAddresses('a@b.com, nonsense; c@d.com')).toEqual([{ addr: 'a@b.com' }, { addr: 'c@d.com' }]);
  });
  it('returns [] for blank input', () => {
    expect(parseAddresses('')).toEqual([]);
    expect(parseAddresses('   ')).toEqual([]);
  });
  it('round-trips through formatAddress', () => {
    expect(formatAddresses(parseAddresses('Bob <bob@acme.com>, c@d.com'))).toBe('"Bob" <bob@acme.com>, c@d.com');
  });
});

describe('textToHtml', () => {
  it('escapes html and keeps line breaks', () => {
    expect(textToHtml('a & <b>\nsecond')).toBe('<p>a &amp; &lt;b&gt;<br>second</p>');
  });
  it('handles CRLF and empty input', () => {
    expect(textToHtml('a\r\nb')).toBe('<p>a<br>b</p>');
    expect(textToHtml('')).toBe('<p></p>');
  });
});
