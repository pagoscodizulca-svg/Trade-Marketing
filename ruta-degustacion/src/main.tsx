import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ejecutarCleanSync } from './services/cleanSync';
import { registerServiceWorker } from './lib/registerSw';
import './index.css';

// La purga de almacenamiento se ejecuta ANTES de montar React y preserva la sesión
// corporativa (`sb-*`, `codizulca.*`) y la base offline del chofer (ver cleanSync.ts).
// El repositorio de entregas arranca EXCLUSIVAMENTE después de autenticar al usuario.
void ejecutarCleanSync().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  registerServiceWorker();
});
