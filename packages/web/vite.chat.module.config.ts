import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { trustedModuleExternalsPlugin } from './vite.shared-module';

export default defineConfig({
  plugins: [
    trustedModuleExternalsPlugin(),
    react(),
    {
      name: 'chat-module-ownership-check',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (
            output.type === 'chunk' &&
            Object.keys(output.modules).some((id) =>
              id.replaceAll('\\', '/').endsWith('/stores/app-store.ts'),
            )
          ) {
            throw new Error('Chat trusted module must never bundle the host app-store');
          }
        }
      },
    },
  ],
  resolve: {
    alias: [
      {
        find: /.*\/stores\/app-store$/,
        replacement: path.resolve('src/plugins/chat-default/store.ts'),
      },
    ],
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    outDir: path.resolve('../../plugins/bundled/hm.plugin.chat-default/ui'),
    emptyOutDir: false,
    target: 'es2022',
    minify: 'esbuild',
    lib: {
      entry: path.resolve('src/plugins/chat-default/module.tsx'),
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
