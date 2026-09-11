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
    allowedHosts: ['migration-agent.uat.signify.net.nz', 'localhost'],
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ai': {
        target: 'http://localhost:8084',
        changeOrigin: true,
      },
    },
  },
});
