import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';

export default defineConfig({
  root: path.resolve('src/plugins/chat-default'),
  plugins: [react(), tailwindcss(), {
    name: 'chat-ownership-check',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk' && Object.keys(output.modules).some(id=>id.replaceAll('\\','/').endsWith('/stores/app-store.ts'))) {
          throw new Error('Chat plugin must never bundle the host app-store');
        }
      }
    },
  }],
  resolve: { alias: [{find:/.*\/stores\/app-store$/,replacement:path.resolve('src/plugins/chat-default/store.ts')}] },
  base: './',
  build: {
    outDir: path.resolve('../../plugins/bundled/hm.plugin.chat-default/ui'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {output:{inlineDynamicImports:true}},
  },
});
