// src/cards/index.ts — aggregation entry point. Anything outside src/cards
// imports from here, never from the individual files directly: this is where
// later tasks (6-11) append side-effect imports of each card module so those
// modules' top-level registerCards(...) calls run exactly once, after
// registry.tsx has already initialized CARD_REGISTRY (see registry.tsx's
// header comment for why those imports can never live in registry.tsx itself).
export * from './types';
export * from './registry';
export { CardShell } from './CardShell';
export { useCardLayout } from './useCardLayout';
export { CardGrid } from './CardGrid';

// Side-effect imports: each card module's top-level registerCards(...) call
// runs once, here, after registry.tsx above has already initialized
// CARD_REGISTRY. Appended by Tasks 6-11 as each page's default cards land.
import './dashboard/coreCards';
import './dashboard/libraryCards';
import './project/coreCards';
import './project/libraryCards';
import './customer/coreCards';
import './customer/libraryCards';
