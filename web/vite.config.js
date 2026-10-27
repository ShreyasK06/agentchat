import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works under any deploy path (GitHub Pages sub-path, Vercel root, file://).
export default defineConfig({
  base: './',
  plugins: [react()],
});
