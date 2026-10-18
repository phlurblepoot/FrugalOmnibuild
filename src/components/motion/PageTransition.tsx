// Page-enter tier of the two-tier transition system (spec §3): springy
// staggered arrival on route changes. Tab switches inside a page use the
// light CSS tier (.anim-tab-in) instead. Keyed on the first two path
// segments so /project/:id section hops and canvas entry do NOT replay the
// entrance (the tab tier owns those), and canvas never sits under a
// transformed ancestor mid-animation.
//
// mode="wait" (NOT "popLayout") is load-bearing: "popLayout" lets the
// outgoing page keep its DOM mounted and fully interactive while its exit
// fade plays, so a route change that lands on a page which immediately
// opens something itself (the app's one-shot `?open=<id>` / `?new=1`
// arrival convention used by RFI/Issue/Task/mail flows) could momentarily
// coexist with a still-live previous page — two independently-interactive
// instances of "the same" element (e.g. two open dialogs, two thread rows)
// at once. Confirmed via a live DOM probe during the mail→RFI conversion flow
// (two concurrent, independently-animating dialog nodes under popLayout).
//
// "wait" alone isn't enough, though: AnimatePresence keeps rendering the
// outgoing wrapper while it fades, and the <Outlet> inside it renders the
// route that matches NOW — the page being entered. That page then mounted
// twice: first in the fading wrapper, where it read and stripped its
// one-shot ?open= and opened the record, then again in its own wrapper,
// which found nothing to open (seen as the mail → "Create RFI" editor
// closing a moment after it appeared). So the outgoing wrapper renders
// nothing, and every page mounts once, in its own wrapper.
import React from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useLocation } from 'react-router-dom';
import { useTheme } from '../../context/ThemeContext';

export function pageKey(pathname: string): string {
  const seg = pathname.split('/').filter(Boolean);
  return seg.slice(0, 2).join('/') || 'root';
}

export const PageTransition: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const { reducedMotion } = useTheme();

  if (reducedMotion) return <>{children}</>;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pageKey(location.pathname)}
        data-page-transition
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.7 }}
        style={{ minHeight: '100%' }}
      >
        <WhilePresent>{children}</WhilePresent>
      </motion.div>
    </AnimatePresence>
  );
};

/** The page, only while its wrapper is the current one (see above). */
const WhilePresent: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  (useIsPresent() ? <>{children}</> : null);
