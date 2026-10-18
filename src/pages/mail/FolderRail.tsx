// src/pages/mail/FolderRail.tsx — left rail of the mail page: Compose, the
// account picker (only when there is more than one mailbox), the role folders
// in mailbox order, then everything else as "Labels".
import React from 'react';
import { Archive, Inbox, Mail, PenSquare, Send, ShieldAlert, Star, Tag, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui';
import type { MailAccount, MailFolder } from './types';

/** Fixed display order + canonical labels for the folders that carry a role. */
const ROLES: Array<{ role: string; label: string; Icon: typeof Inbox }> = [
  { role: 'inbox', label: 'Inbox', Icon: Inbox },
  { role: 'starred', label: 'Starred', Icon: Star },
  { role: 'sent', label: 'Sent', Icon: Send },
  { role: 'drafts', label: 'Drafts', Icon: Mail },
  { role: 'archive', label: 'Archive', Icon: Archive },
  { role: 'trash', label: 'Trash', Icon: Trash2 },
  { role: 'spam', label: 'Spam', Icon: ShieldAlert },
];

export interface RailFolder {
  folder: MailFolder;
  label: string;
  Icon: typeof Inbox;
}

/** Role folders in mailbox order, then the rest alphabetically. */
export function orderFolders(folders: MailFolder[]): { roleFolders: RailFolder[]; labelFolders: RailFolder[] } {
  const roleFolders: RailFolder[] = [];
  const used = new Set<string>();

  for (const { role, label, Icon } of ROLES) {
    const match = folders.find(f => f.role === role);
    if (!match) continue;
    roleFolders.push({ folder: match, label, Icon });
    used.add(match.id);
  }

  const labelFolders = folders
    .filter(f => !used.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(f => ({ folder: f, label: f.name, Icon: Tag }));

  return { roleFolders, labelFolders };
}

const FolderButton: React.FC<{ item: RailFolder; selected: boolean; onSelect: (id: string) => void }> = ({
  item,
  selected,
  onSelect,
}) => {
  const { folder, label, Icon } = item;
  return (
    <button
      type="button"
      data-testid="mail-folder-row"
      data-folder-id={folder.id}
      data-selected={String(selected)}
      onClick={() => onSelect(folder.id)}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-hover ${
        selected ? 'bg-hover font-medium text-ink' : 'text-ink-soft'
      }`}
    >
      <Icon size={15} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {folder.unreadCount > 0 && (
        <span
          role="img"
          aria-label={`${folder.unreadCount} unread`}
          className="shrink-0 rounded-full bg-accent-500/15 px-1.5 text-[11px] font-medium leading-5 text-accent-700 dark:text-accent-300"
        >
          {folder.unreadCount}
        </span>
      )}
    </button>
  );
};

export const FolderRail: React.FC<{
  accounts: MailAccount[];
  accountId: string | null;
  folders: MailFolder[];
  folderId: string | null;
  onSelectAccount: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onCompose: () => void;
}> = ({ accounts, accountId, folders, folderId, onSelectAccount, onSelectFolder, onCompose }) => {
  const { roleFolders, labelFolders } = orderFolders(folders);
  const current = accounts.find(a => a.id === accountId) ?? accounts[0];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="space-y-2 border-b border-edge p-3">
        <Button size="sm" className="w-full" data-testid="mail-compose-open" onClick={onCompose}>
          <PenSquare size={14} />
          <span>Compose</span>
        </Button>

        {accounts.length > 1 ? (
          <select
            aria-label="Mail account"
            value={accountId ?? ''}
            onChange={e => onSelectAccount(e.target.value)}
            className="w-full rounded-lg border border-edge bg-raised px-2 py-1.5 text-xs text-ink focus:border-accent-400 focus-visible:outline-none"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.emailAddress}
              </option>
            ))}
          </select>
        ) : (
          current && (
            <p className="truncate text-xs text-ink-faint" title={current.emailAddress}>
              {current.emailAddress}
            </p>
          )
        )}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {roleFolders.map(item => (
          <FolderButton key={item.folder.id} item={item} selected={item.folder.id === folderId} onSelect={onSelectFolder} />
        ))}

        {labelFolders.length > 0 && (
          <>
            <p className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Labels</p>
            {labelFolders.map(item => (
              <FolderButton key={item.folder.id} item={item} selected={item.folder.id === folderId} onSelect={onSelectFolder} />
            ))}
          </>
        )}
      </nav>
    </div>
  );
};
