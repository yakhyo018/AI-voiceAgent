import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST + SSE 모두 NestJS(3001)로 프록시
      '/api': { target: `http://localhost:${process.env.API_PORT || 3001}`, changeOrigin: true },
    },
  },
});
