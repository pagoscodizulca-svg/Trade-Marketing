import './bootTheme'; // Primero: aplica `data-theme` desde `codizulca.ui_theme` sin FOUC ni scripts inline (CSP 'self')
import './services/bootCleanSync'; // Segundo: purga datos heredados preservando sesión y `codizulca.ui_theme`
import { createRoot } from 'react-dom/client';
import { startAppVersionGuard } from './lib/appVersionGuard';
import { registerTradeServiceWorker } from './lib/registerTradeSw';
import App from './App.tsx';
import { AppUpdateBanner } from './components/common/AppUpdateBanner';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ThemeModeProvider } from './context/ThemeModeContext';
import './index.css';

startAppVersionGuard({ versionUrl: '/version.json', swScope: '/' });
void registerTradeServiceWorker();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeModeProvider>
      <App />
      <AppUpdateBanner />
    </ThemeModeProvider>
  </ErrorBoundary>
);
