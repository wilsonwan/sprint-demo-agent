import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The agent's Node server serves the built app (dist/) and the API. In development, Vite serves
// the app and forwards /api to the agent.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4400', ws: true } } },
});
