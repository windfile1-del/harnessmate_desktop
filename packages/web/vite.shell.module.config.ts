import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { trustedModuleExternalsPlugin } from './vite.shared-module';

export default defineConfig({
  plugins: [trustedModuleExternalsPlugin(), react()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    outDir: path.resolve('../../plugins/bundled/hm.plugin.shell-default/ui'),
    emptyOutDir: false,
    target: 'es2022',
    minify: 'esbuild',
    lib: {
      entry: path.resolve('src/plugins/shell-default/module.tsx'),
      formats: ['es'],
      fileName: () => 'module.mjs',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
