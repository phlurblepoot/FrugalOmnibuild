import '@fontsource-variable/inter';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerServiceWorker } from './utils/push';
import { startMediaSession } from './utils/store';

// Phone push notifications (public/sw.js). Harmless where there are none.
void registerServiceWorker();

// Photos and PDFs load with the media cookie (server/auth.ts). Someone still
// signed in from before it existed has only their token, so the cookie is
// set before the first image can render (a few seconds at most).
void startMediaSession().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
