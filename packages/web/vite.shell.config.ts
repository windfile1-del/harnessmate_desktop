import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve('src/plugins/shell-default'),
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: path.resolve('../../plugins/bundled/hm.plugin.shell-default/ui'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
