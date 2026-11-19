import './bootTheme'; // Primero: aplica `data-theme` desde `codizulca.ui_theme` sin FOUC ni scripts inline (CSP 'self')
import './services/bootCleanSync'; // Segundo: purga datos heredados preservando sesión y `codizulca.ui_theme`
import { createRoot } from 'react-dom/client';
import { registerTradeServiceWorker } from './lib/registerTradeSw';
import App from './App.tsx';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ThemeModeProvider } from './context/ThemeModeContext';
import './index.css';

void registerTradeServiceWorker();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeModeProvider>
      <App />
    </ThemeModeProvider>
  </ErrorBoundary>
);
