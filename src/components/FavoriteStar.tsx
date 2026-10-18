// src/components/FavoriteStar.tsx
import React from 'react';
import { Star } from 'lucide-react';
import { useFavoriteProjects } from '../hooks/useFavoriteProjects';
import { useToast } from './Toast';

// Star toggle for a project. Stops click propagation so it works inside
// clickable cards.
export const FavoriteStar: React.FC<{ projectId: string; size?: number; className?: string }> = ({ projectId, size = 15, className = '' }) => {
  const { isFavorite, toggle } = useFavoriteProjects();
  const { toast } = useToast();
  const fav = isFavorite(projectId);
  return (
    <button
      type="button"
      data-testid="favorite-star"
      aria-pressed={fav}
      aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
      title={fav ? 'Remove from favorites' : 'Add to favorites'}
      onClick={e => {
        e.stopPropagation();
        toggle(projectId).catch(() => toast('Could not update favorites', { type: 'error' }));
      }}
      className={`flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-md p-1.5 transition-colors hover:bg-hover md:min-h-0 md:min-w-0 ${fav ? 'text-amber-500' : 'text-ink-faint hover:text-ink'} ${className}`}
    >
      <Star size={size} fill={fav ? 'currentColor' : 'none'} />
    </button>
  );
};
