import { describe, it, expect } from 'vitest';
import { editorPath, normalizeActionLink, parseActionLinkParam } from './editorLinks';

describe('editor links', () => {
  const LINK = { action: { type: 'comment', data: 'c_42' } };

  it('points at a comment through ?comment=, and round-trips', () => {
    const path = editorPath('f 1', LINK);
    expect(path.startsWith('/tools/edit?fileId=f%201&comment=')).toBe(true);
    expect(parseActionLinkParam(new URLSearchParams(path.split('?')[1]).get('comment'))).toEqual(LINK);
    expect(editorPath('f1')).toBe('/tools/edit?fileId=f1');
  });

  it('ignores anything but a small plain object', () => {
    for (const bad of [null, 'x', 5, [1], { big: 'x'.repeat(3000) }]) expect(normalizeActionLink(bad)).toBeNull();
    expect(editorPath('f1', 'nonsense')).toBe('/tools/edit?fileId=f1');
    expect(parseActionLinkParam('{not json')).toBeNull();
    expect(parseActionLinkParam(null)).toBeNull();
  });
});
