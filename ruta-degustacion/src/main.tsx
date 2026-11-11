import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ejecutarCleanSync } from './services/cleanSync';
import { entregasRepo } from './services';
import { registerServiceWorker } from './lib/registerSw';
import './index.css';

// La purga de almacenamiento se ejecuta ANTES de montar React y de arrancar la sincronización
// (conserva la base offline del chofer: ver BASE_OFFLINE en cleanSync.ts).
void ejecutarCleanSync().finally(() => {
  entregasRepo.start();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  registerServiceWorker();
});
