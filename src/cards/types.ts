// src/cards/types.ts
//
// Card system core types (Wave 2 spec, UI rehaul). A "card" is a self-
// contained widget rendered inside CardShell chrome and placed on a page's
// grid per the user's (or default) CardLayout. See registry.tsx for the
// registration API and CardShell.tsx for the shared chrome.
import React from 'react';

export type CardPage = 'dashboard' | 'project' | 'customer';

// Grid columns a card can occupy. 3 = full width on the standard 3-col grid.
export type CardWidth = 1 | 2 | 3;

export interface CardContext {
  isAdmin: boolean;
  projectId?: string;
  customerId?: string;
}

export interface CardDef {
  id: string;                       // stable, e.g. 'dash-attention'
  title: string;
  icon: React.FC<{ size?: number; className?: string }>;  // lucide
  page: CardPage;
  widths: CardWidth[];              // supported widths
  defaultWidth: CardWidth;
  adminOnly?: boolean;
  Component: React.FC<{ width: CardWidth; ctx: CardContext }>;
}

export interface CardLayoutEntry { id: string; width: CardWidth }
export interface CardLayout { version: 1; cards: CardLayoutEntry[] }

// CardShell's empty-state illustration kind. Defined here (rather than in the
// Task 12 art component) so CardShell can type against it now — the art
// component lands later and imports this type instead of the reverse.
export type EmptyKind = 'clear' | 'inbox' | 'money' | 'checklist' | 'photos' | 'blueprint';
