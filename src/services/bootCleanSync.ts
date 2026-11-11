import { runCleanSyncMigration } from './cleanSync';

// Efecto lateral intencional: este módulo debe importarse PRIMERO en main.tsx (ESM evalúa los imports en orden),
// de modo que la purga ocurra antes de que cualquier otro módulo lea el almacenamiento del navegador.
runCleanSyncMigration();
