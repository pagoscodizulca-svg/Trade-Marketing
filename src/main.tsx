import './services/bootCleanSync'; // DEBE ser el primer import: purga datos de prueba/caché heredados (una vez por versión)
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
