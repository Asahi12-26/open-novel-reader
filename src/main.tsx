import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles.css';
const update = registerSW({ onNeedRefresh() { window.dispatchEvent(new CustomEvent('reader-update', { detail: update })); } });
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
