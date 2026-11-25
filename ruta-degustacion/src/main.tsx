import './bootTheme'; // Primero: aplica `data-theme` desde `codizulca.ui_theme` sin FOUC
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ejecutarCleanSync } from './services/cleanSync';
import { startRutaVersionGuard } from './lib/appVersionGuard';
import { registerServiceWorker } from './lib/registerSw';
import './index.css';

// La purga de almacenamiento se ejecuta ANTES de montar React y preserva la sesión
// corporativa (`sb-*`, `codizulca.*`, incluyendo `codizulca.ui_theme`) y la base offline del chofer.
void ejecutarCleanSync().finally(() => {
  startRutaVersionGuard();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  registerServiceWorker();
});
