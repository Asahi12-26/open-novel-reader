import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { isTauri } from '@tauri-apps/api/core';
import App from './App';
import './styles.css';
if (isTauri()) {
  // Native assets ship inside the application. A PWA cache must never mask a newly installed bundle.
  if ('serviceWorker' in navigator) void navigator.serviceWorker.getRegistrations().then(async registrations => {
    await Promise.all(registrations.map(registration => registration.unregister()));
    if (registrations.length && navigator.serviceWorker.controller) window.location.reload();
  }).catch(() => {});
} else {
  const update = registerSW({ onNeedRefresh() { window.dispatchEvent(new CustomEvent('reader-update', { detail: update })); } });
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
