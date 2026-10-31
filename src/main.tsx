import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/v1.css';
import './styles/v1-pages.css';
import './styles/v1-fixed.css';
import './styles/v1-backup.css';
import './styles/v1-keypad.css';

// Hash routing keeps every screen reachable on a static file:// WebView, where
// history-API paths would 404 after a reload.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);