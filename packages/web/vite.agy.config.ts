import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('src/plugins/agy-workbench-default'),
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'agy-workbench-ownership-check',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (
            output.type === 'chunk' &&
            Object.keys(output.modules).some((id) =>
              id.replaceAll('\\', '/').endsWith('/stores/app-store.ts'),
            )
          ) {
            throw new Error('AGY workbench plugin must never bundle the host app-store');
          }
        }
      },
    },
  ],
  resolve: {
    alias: [
      {
        find: /.*\/stores\/app-store$/,
        replacement: path.resolve('src/plugins/agy-workbench-default/store.ts'),
      },
    ],
  },
  base: './',
  build: {
    outDir: path.resolve('../../plugins/bundled/hm.plugin.agy-workbench-default/ui'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
