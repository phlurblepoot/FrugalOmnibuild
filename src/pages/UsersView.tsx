import React, { useState } from 'react';
import { UserPlus, Trash2, Shield, User, Loader2 } from 'lucide-react';
import { getAuthHeaders } from '../utils/store';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { Card, Table, THead, TBody, TR, TH, TD } from '../components/ui';

interface UserData {
  id: string;
  username: string;
  role: string;
}

const currentUserId: string = (() => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').id || ''; }
  catch { return ''; }
})();

export const UsersView: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [users, setUsers] = useState<UserData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [isAdding, setIsAdding] = useState(false);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/users', { headers: getAuthHeaders() });
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useLiveQuery(fetchUsers, { types: ['user'] });

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newPassword) return;

    setIsAdding(true);
    setError('');

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');

      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      fetchUsers();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRoleChange = async (id: string, prevRole: string, nextRole: string) => {
    if (nextRole === prevRole) return;
    // Optimistically reflect the change; revert on failure.
    setUsers(prev => prev.map(u => (u.id === id ? { ...u, role: nextRole } : u)));
    try {
      const res = await fetch(`/api/users/${id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ role: nextRole })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update role');
      setUsers(prev => prev.map(u => (u.id === id ? { ...u, role: data.role } : u)));
      toast('Role updated', { type: 'success' });
    } catch (err: any) {
      // Revert the select to the previous value since the change didn't persist.
      setUsers(prev => prev.map(u => (u.id === id ? { ...u, role: prevRole } : u)));
      toast(err.message, { type: 'error' });
    }
  };

  const handleDeleteUser = async (id: string) => {
    if (!await confirm({ title: 'Delete user', message: 'Are you sure you want to delete this user?', confirmLabel: 'Delete', tone: 'danger' })) return;

    try {
      const res = await fetch(`/api/users/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete user');
      }

      fetchUsers();
    } catch (err: any) {
      toast(err.message, { type: 'error' });
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 size={32} className="text-accent-600 animate-spin" />
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-6 border-b border-edge bg-sunken">
        <h2 className="text-lg font-bold text-ink mb-4">Add New User</h2>

        {error && (
          <div className="bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 p-3 rounded-lg mb-4 text-sm font-medium border border-red-100 dark:border-red-900">
            {error}
          </div>
        )}

        <form onSubmit={handleAddUser} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Username</label>
            <input
              type="text"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-edge-strong bg-raised text-ink placeholder:text-ink-faint focus:ring-2 focus:ring-accent-500 outline-none"
              placeholder="e.g. jdoe"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-edge-strong bg-raised text-ink placeholder:text-ink-faint focus:ring-2 focus:ring-accent-500 outline-none"
              placeholder="Enter password"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Role</label>
            <select
              value={newRole}
              onChange={e => setNewRole(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-edge-strong bg-raised text-ink focus:ring-2 focus:ring-accent-500 outline-none"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={isAdding || !newUsername || !newPassword}
            className="flex items-center justify-center gap-2 bg-accent-600 hover:bg-accent-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 h-[42px]"
          >
            {isAdding ? <Loader2 size={18} className="animate-spin" /> : <UserPlus size={18} />}
            Add User
          </button>
        </form>
      </div>

      <Table>
        <THead>
          <TR>
            <TH>Username</TH>
            <TH>Role</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <TBody>
          {users.length === 0 ? (
            <TR>
              <TD colSpan={3} className="text-center py-8 text-ink-soft">
                No users found.
              </TD>
            </TR>
          ) : (
            users.map((user) => (
              <TR key={user.id} className="group">
                <TD className="font-medium text-ink flex items-center gap-2">
                  <User size={16} className="text-ink-faint" />
                  {user.username}
                </TD>
                <TD>
                  <div className="flex items-center gap-2">
                    {user.role === 'admin' && (
                      <Shield size={14} className="text-purple-600 dark:text-purple-400 shrink-0" />
                    )}
                    <select
                      value={user.role}
                      disabled={user.id === currentUserId}
                      onChange={e => handleRoleChange(user.id, user.role, e.target.value)}
                      title={user.id === currentUserId ? "You can't change your own role" : 'Change role'}
                      className={`px-2.5 py-1 rounded-lg border text-xs font-medium outline-none focus:ring-2 focus:ring-accent-500 ${
                        user.role === 'admin'
                          ? 'border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                          : 'border-accent-200 dark:border-accent-800 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
                      } disabled:opacity-60 disabled:cursor-not-allowed dark:[color-scheme:dark]`}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </TD>
                <TD className="text-right">
                  <button
                    onClick={() => handleDeleteUser(user.id)}
                    className="text-ink-faint hover:text-red-500 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete User"
                  >
                    <Trash2 size={18} />
                  </button>
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>
    </Card>
  );
};
