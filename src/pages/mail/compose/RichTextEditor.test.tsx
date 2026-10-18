// src/pages/mail/compose/RichTextEditor.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { RichTextEditor, type RichTextEditorHandle } from './RichTextEditor';

const ready = async (ref: React.RefObject<RichTextEditorHandle | null>): Promise<Editor> => {
  await waitFor(() => expect(ref.current?.editor).toBeTruthy());
  return ref.current!.editor!;
};

beforeEach(() => vi.clearAllMocks());

describe('RichTextEditor', () => {
  it('renders the placeholder on an empty document', async () => {
    const ref = React.createRef<RichTextEditorHandle>();
    const { container } = render(
      <RichTextEditor ref={ref} value="" onChange={vi.fn()} placeholder="Write your message…" />
    );
    await ready(ref);
    await waitFor(() =>
      expect(container.querySelector('[data-placeholder="Write your message…"]')).toBeTruthy()
    );
  });

  it('reports html up through onChange as the document changes', async () => {
    const onChange = vi.fn();
    const ref = React.createRef<RichTextEditorHandle>();
    render(<RichTextEditor ref={ref} value="" onChange={onChange} />);
    const editor = await ready(ref);

    act(() => { editor.commands.insertContent('hello world'); });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toContain('hello world');
  });

  it('toggles bold from the toolbar', async () => {
    const onChange = vi.fn();
    const ref = React.createRef<RichTextEditorHandle>();
    render(<RichTextEditor ref={ref} value="<p>hello</p>" onChange={onChange} />);
    const editor = await ready(ref);

    act(() => { editor.commands.selectAll(); });
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));

    await waitFor(() => expect(editor.getHTML()).toContain('<strong>'));
    expect(onChange.mock.calls.at(-1)![0]).toContain('<strong>');
  });

  it('toggles a bullet list from the toolbar', async () => {
    const ref = React.createRef<RichTextEditorHandle>();
    render(<RichTextEditor ref={ref} value="<p>hello</p>" onChange={vi.fn()} />);
    const editor = await ready(ref);

    fireEvent.click(screen.getByRole('button', { name: 'Bulleted list' }));
    await waitFor(() => expect(editor.getHTML()).toContain('<ul>'));
  });

  it('adds a link from the toolbar prompt and skips a cancelled prompt', async () => {
    const ref = React.createRef<RichTextEditorHandle>();
    render(<RichTextEditor ref={ref} value="<p>hello</p>" onChange={vi.fn()} />);
    const editor = await ready(ref);
    act(() => { editor.commands.selectAll(); });

    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(editor.getHTML()).not.toContain('<a ');

    prompt.mockReturnValue('https://example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(editor.getHTML()).toContain('https://example.com'));
    prompt.mockRestore();
  });

  it('clears formatting', async () => {
    const ref = React.createRef<RichTextEditorHandle>();
    render(<RichTextEditor ref={ref} value="<p><strong>hello</strong></p>" onChange={vi.fn()} />);
    const editor = await ready(ref);
    act(() => { editor.commands.selectAll(); });

    fireEvent.click(screen.getByRole('button', { name: 'Clear formatting' }));
    await waitFor(() => expect(editor.getHTML()).not.toContain('<strong>'));
  });

  it('adopts an outside value change without echoing it back as an edit', async () => {
    const onChange = vi.fn();
    const ref = React.createRef<RichTextEditorHandle>();
    const { rerender } = render(<RichTextEditor ref={ref} value="<p>one</p>" onChange={onChange} />);
    const editor = await ready(ref);

    onChange.mockClear();
    rerender(<RichTextEditor ref={ref} value="<p>two</p>" onChange={onChange} />);
    await waitFor(() => expect(editor.getHTML()).toContain('two'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
