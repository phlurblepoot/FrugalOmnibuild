// src/pages/Dashboard.tsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '../components/ui';
import { CardGrid } from '../cards';

// Re-exported for back-compat — ProjectOverview.tsx / ProjectTime.tsx import
// these from this module. Canonical implementations now live in
// src/utils/time.ts (shared with the card modules, which can't import this
// file directly without a circular import through CardGrid).
export { timeAgo, startOfWeek, hoursThisWeek } from '../utils/time';

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const isAdmin = (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Dashboard</h1>
          <p className="text-sm text-ink-faint">Welcome back{user.username ? `, ${user.username}` : ''}.</p>
        </div>
        <Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>
      </div>

      <CardGrid page="dashboard" ctx={{ isAdmin }} />
    </div>
  );
};
