import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import '@fontsource/barlow-semi-condensed/600.css';
import './styles.css';
import { AuthProvider } from './auth.tsx';
import { App } from './App.tsx';
import { applyThemePref } from './ui/theme.ts';

applyThemePref();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
