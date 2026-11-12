import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/router.tsx';
import { Providers } from './app/providers.tsx';
import '@code-along/design-system/tokens.css';
import '@code-along/design-system/components.css';
import './styles.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
