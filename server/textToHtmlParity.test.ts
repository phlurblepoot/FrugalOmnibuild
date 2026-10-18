// server/textToHtmlParity.test.ts
// The client converts an editor's plain-text email body to html before handing
// it to the mail composer; the server does the same for any caller that still
// posts `body`. Two implementations, one output — a drift between them means
// the same message reads differently depending on which path it took.
//
// This is the only test that imports both, so it lives in the server project
// (which can see src/) rather than in either module's own suite.
import { describe, it, expect } from 'vitest';
import { textToHtml as serverTextToHtml } from './routes';
import { textToHtml as clientTextToHtml } from '../src/utils/email';

const CASES = [
  'plain',
  'a & b',
  '<script>alert(1)</script>',
  'line one\nline two',
  'crlf\r\nsecond',
  'trailing\n',
  '',
  'quotes "and" \'apostrophes\'',
  'ampersand entity &amp; already escaped',
];

describe('textToHtml parity', () => {
  it.each(CASES)('client and server agree on %j', text => {
    expect(clientTextToHtml(text)).toBe(serverTextToHtml(text));
  });
});
