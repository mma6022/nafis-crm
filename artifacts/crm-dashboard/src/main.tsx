import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { startAppVersionWatch } from '@/lib/app-version';

import './index.css';
import './theme/nafis-theme.css';
import './theme/tokens.css';

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

// Stale tabs pick up a new release (crm-nid-quick).
startAppVersionWatch();
