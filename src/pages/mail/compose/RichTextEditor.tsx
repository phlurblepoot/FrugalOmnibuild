// src/pages/mail/compose/RichTextEditor.tsx — the composer's body field.
//
// Email bodies are HTML, and the app already sends HTML documents through the
// same pipes, so the editor speaks HTML in and HTML out rather than Markdown.
// TipTap v3's StarterKit already bundles Link and Underline (v2 did not), so
// they are configured through the kit instead of being registered twice —
// registering the standalone extensions alongside it warns about duplicates.
import React, { useEffect, useImperativeHandle } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import {
  Bold, Eraser, Heading2, Italic, Link2, List, ListOrdered, Quote, Underline as UnderlineIcon,
} from 'lucide-react';

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  autoFocus?: boolean;
}

/** Exposed so callers (and tests) can drive the editor imperatively. */
export interface RichTextEditorHandle {
  editor: Editor | null;
  focus: () => void;
}

const BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded text-ink-faint transition-colors ' +
  'hover:bg-hover hover:text-ink disabled:opacity-40';
const ACTIVE = 'bg-hover text-ink';

const ToolbarButton: React.FC<{
  label: string; active?: boolean; onClick: () => void; children: React.ReactNode;
}> = ({ label, active, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={active}
    // mousedown is prevented so clicking the toolbar never steals the caret —
    // otherwise "select text, click Bold" loses the selection before the command runs.
    onMouseDown={e => e.preventDefault()}
    onClick={onClick}
    className={`${BTN} ${active ? ACTIVE : ''}`}
  >
    {children}
  </button>
);

export const RichTextEditor = React.forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  ({ value, onChange, placeholder, minHeight = 180, autoFocus }, ref) => {
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3] },
          link: { openOnClick: false, autolink: true },
        }),
        Placeholder.configure({ placeholder: placeholder ?? '' }),
      ],
      content: value,
      autofocus: autoFocus ? 'end' : false,
      // v3 defaults this to false, which would leave the toolbar's active
      // states frozen at their mount-time values.
      shouldRerenderOnTransaction: true,
      editorProps: {
        attributes: {
          class: 'ft-mail-body prose-sm max-w-none px-3 py-2 text-sm text-ink focus:outline-none',
          style: `min-height:${minHeight}px`,
        },
      },
      onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    });

    useImperativeHandle(ref, () => ({
      editor: editor ?? null,
      focus: () => editor?.commands.focus('end'),
    }), [editor]);

    // Content pushed in from outside (seeding a reply, inserting a quote) is
    // adopted without emitting an update, so it isn't echoed back as an edit.
    // The guard also stops every keystroke from round-tripping through here.
    useEffect(() => {
      if (!editor) return;
      if (value === editor.getHTML()) return;
      editor.commands.setContent(value || '', { emitUpdate: false });
    }, [editor, value]);

    const can = (fn: () => void) => () => { if (editor) fn(); };

    const setLink = () => {
      if (!editor) return;
      const previous = editor.getAttributes('link').href as string | undefined;
      const url = window.prompt('Link URL', previous ?? 'https://');
      if (url === null) return;                       // cancelled — leave the doc alone
      if (!url.trim()) {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
        return;
      }
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
    };

    return (
      <div className="rounded-lg border border-edge focus-within:border-accent-500">
        <div className="flex flex-wrap items-center gap-0.5 border-b border-edge px-1.5 py-1" data-testid="editor-toolbar">
          <ToolbarButton label="Bold" active={editor?.isActive('bold')} onClick={can(() => editor!.chain().focus().toggleBold().run())}>
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton label="Italic" active={editor?.isActive('italic')} onClick={can(() => editor!.chain().focus().toggleItalic().run())}>
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton label="Underline" active={editor?.isActive('underline')} onClick={can(() => editor!.chain().focus().toggleUnderline().run())}>
            <UnderlineIcon size={14} />
          </ToolbarButton>

          <span className="mx-1 h-4 w-px bg-edge" aria-hidden="true" />

          <ToolbarButton label="Heading" active={editor?.isActive('heading', { level: 2 })} onClick={can(() => editor!.chain().focus().toggleHeading({ level: 2 }).run())}>
            <Heading2 size={14} />
          </ToolbarButton>
          <ToolbarButton label="Bulleted list" active={editor?.isActive('bulletList')} onClick={can(() => editor!.chain().focus().toggleBulletList().run())}>
            <List size={14} />
          </ToolbarButton>
          <ToolbarButton label="Numbered list" active={editor?.isActive('orderedList')} onClick={can(() => editor!.chain().focus().toggleOrderedList().run())}>
            <ListOrdered size={14} />
          </ToolbarButton>
          <ToolbarButton label="Quote" active={editor?.isActive('blockquote')} onClick={can(() => editor!.chain().focus().toggleBlockquote().run())}>
            <Quote size={14} />
          </ToolbarButton>

          <span className="mx-1 h-4 w-px bg-edge" aria-hidden="true" />

          <ToolbarButton label="Link" active={editor?.isActive('link')} onClick={setLink}>
            <Link2 size={14} />
          </ToolbarButton>
          <ToolbarButton label="Clear formatting" onClick={can(() => editor!.chain().focus().unsetAllMarks().clearNodes().run())}>
            <Eraser size={14} />
          </ToolbarButton>
        </div>

        <EditorContent editor={editor} />
      </div>
    );
  }
);
RichTextEditor.displayName = 'RichTextEditor';
