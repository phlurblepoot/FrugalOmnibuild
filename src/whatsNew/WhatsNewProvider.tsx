// src/whatsNew/WhatsNewProvider.tsx
// Opens the "What's new" popup when the app starts (or someone signs in) on a
// newer version than the one they last saw, and saves the version once they
// close it. Settings › Changelog opens it again through useWhatsNew().
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getWhatsNewSeen, setWhatsNewSeen } from '../utils/store';
import { isBareRoute } from '../utils/locationInfo';
import { RELEASES, type WhatsNewRelease } from './releases';
import { APP_VERSION, compareVersions, releasesToShow } from './versions';
import { WhatsNewModal } from './WhatsNewModal';

const WhatsNewContext = createContext<{ show: () => void }>({ show: () => {} });

/** `show()` opens the popup for the newest release (from Settings). */
export const useWhatsNew = () => useContext(WhatsNewContext);

export const WhatsNewProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { pathname } = useLocation();
  const [releases, setReleases] = useState<WhatsNewRelease[]>([]);
  const [open, setOpen] = useState(false);
  // The session (token) already checked: once per sign-in, whatever page comes first.
  const checked = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const token = localStorage.getItem('token');
  useEffect(() => {
    if (!token || isBareRoute(pathname) || checked.current === token) return;
    checked.current = token;
    getWhatsNewSeen().then(lastSeen => {
      if (!mounted.current) return;
      const due = releasesToShow(RELEASES, lastSeen, APP_VERSION);
      if (due.length) { setReleases(due); setOpen(true); }
      // Nothing to show for this update: just remember it.
      else if (!lastSeen || compareVersions(lastSeen, APP_VERSION) < 0) void setWhatsNewSeen(APP_VERSION).catch(() => {});
    }).catch(() => { /* offline or signed out: try again next time the app starts */ });
  }, [token, pathname]);

  const close = useCallback(() => {
    setOpen(false);
    void setWhatsNewSeen(APP_VERSION).catch(() => {});
  }, []);

  const show = useCallback(() => {
    const latest = releasesToShow(RELEASES, null, APP_VERSION).slice(0, 1);
    if (!latest.length) return;
    setReleases(latest);
    setOpen(true);
  }, []);

  return (
    <WhatsNewContext.Provider value={{ show }}>
      {children}
      <WhatsNewModal open={open} releases={releases} onClose={close} />
    </WhatsNewContext.Provider>
  );
};
