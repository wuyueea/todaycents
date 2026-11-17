import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/today.css';
import './styles/entry.css';
import './styles/ledger.css';
import './styles/charts.css';
import './styles/accounts.css';
import './styles/settings.css';
import './styles/tags.css';
import './styles/categories.css';
import './styles/backup.css';
import './styles/overlays.css';
import './styles/projects.css';
import './styles/fixed-costs.css';
import './styles/reports.css';
import './styles/v1.css';
import './styles/v1-pages.css';
import './styles/v1-fixed.css';
import './styles/v1-backup.css';
import './styles/v1-keypad.css';
import './styles/touch-targets.css';
import './styles/txn-delete.css';

// Hash routing keeps every screen reachable on a static file:// WebView, where
// history-API paths would 404 after a reload.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
