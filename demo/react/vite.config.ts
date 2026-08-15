import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tokenRoute } from '../token-route';

export default defineConfig({
  plugins: [react(), tokenRoute()],
  server: { port: 5173 },
});
