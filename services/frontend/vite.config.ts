import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js references Node's `global` at runtime; Vite
  // does not shim it, so the app fails to mount without this define.
  define: { global: 'globalThis' },
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: ['migration.callsphere.site', 'circini.callsphere.site', 'callsphere.site', 'www.callsphere.site', 'localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ai': {
        target: 'http://localhost:8084',
        changeOrigin: true,
      },
    },
  },
});
