import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { trustedModuleExternalsPlugin } from './vite.shared-module';
export default defineConfig({ plugins: [trustedModuleExternalsPlugin(), react(), { name: 'management-ownership', generateBundle(_opts, bundle) {
  for (const item of Object.values(bundle)) if (item.type === 'chunk' && Object.keys(item.modules).some(id => id.replaceAll('\\','/').endsWith('/stores/app-store.ts'))) throw new Error('Management/developer plugin may not import private app-store');
} }], define: { 'process.env.NODE_ENV': '"production"' }, build: { outDir: path.resolve('../../plugins/bundled/hm.plugin.developer-tools/ui'), emptyOutDir: false, target: 'es2022', lib: { entry: path.resolve('src/plugins/developer-tools/module.tsx'), formats: ['es'], fileName: () => 'module.mjs' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
