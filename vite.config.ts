import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { readPublicCloudConfig } from './src/core/public-cloud-config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  if (env.VITE_SUPABASE_URL || env.VITE_SUPABASE_ANON_KEY) {
    try { readPublicCloudConfig(env.VITE_SUPABASE_URL || '', env.VITE_SUPABASE_ANON_KEY || ''); }
    catch { throw new Error('Invalid public Supabase build configuration. Supply the project HTTPS origin and a publishable or anon key together.'); }
  }
  return {
  base: './',
  plugins: [react(), { name: 'distribution-notices', generateBundle() {
    for (const [source, fileName] of [['LICENSE','legal/AGPL-3.0.txt'], ['THIRD_PARTY_NOTICES.md','legal/THIRD_PARTY_NOTICES.md'], ['docs/licenses/DEPENDENCY_NOTICES.txt','legal/DEPENDENCY_NOTICES.txt']] as const) {
      this.emitFile({ type: 'asset', fileName, source: readFileSync(source,'utf8') });
    }
  } }, VitePWA({ registerType: 'prompt', includeAssets: ['icon.svg'], manifest: {
    name: '阅见 · Open Novel Reader', short_name: '阅见', description: '你的随身文学馆，免费开源的小说阅读器',
    theme_color: '#f5f2eb', background_color: '#f5f2eb', display: 'standalone', start_url: './', scope: './',
    icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
  }, workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2,txt,md}'], maximumFileSizeToCacheInBytes: 4000000, navigateFallbackDenylist: [/^\/auth/, /^\/api/], cleanupOutdatedCaches: true } })],
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', rollupOptions: { output: { manualChunks: { react: ['react','react-dom'], motion: ['motion/react'], storage: ['dexie','jszip'], cloud: ['@supabase/supabase-js'] } } } },
  };
});
