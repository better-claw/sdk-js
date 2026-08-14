import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { tokenRoute } from '../token-route';

export default defineConfig({
  plugins: [vue(), tokenRoute()],
  server: { port: 5174 },
});
