import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// StrictMode is intentionally not used: it double-mounts effects in development,
// which would create and dispose the Fabric canvas twice.
createRoot(document.getElementById('root')!).render(<App />);
