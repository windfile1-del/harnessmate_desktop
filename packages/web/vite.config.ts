import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const FORBIDDEN_HOST_MODULES = [
  '/stores/app-store.ts',
  '/components/Sidebar.tsx',
  '/components/InspectorDrawer.tsx',
  '/components/Modals.tsx',
  '/components/CommandPalette.tsx',
  '/components/TriageInbox.tsx',
  '/plugins/shell-default/',
];

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'kernel-root-ownership-check',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue;
          for (const moduleId of Object.keys(output.modules)) {
            const normalized = moduleId.replaceAll('\\', '/');
            const hit = FORBIDDEN_HOST_MODULES.find((suffix) => normalized.includes(suffix));
            if (hit) {
              throw new Error(
                `Host kernel bundle must not statically import business/layout module (${hit}): ${normalized}`,
              );
            }
          }
        }
      },
    },
  ],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4789',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (normalized.includes('/node_modules/')) {
            if (
              normalized.includes('/node_modules/react/') ||
              normalized.includes('/node_modules/react-dom/') ||
              normalized.includes('/node_modules/scheduler/') ||
              normalized.includes('/node_modules/zustand/')
            ) {
              return 'vendor-react';
            }
            if (
              normalized.includes('/node_modules/highlight.js/') ||
              normalized.includes('/node_modules/lowlight/')
            ) {
              return 'vendor-highlight';
            }
            if (
              normalized.includes('/node_modules/react-markdown/') ||
              normalized.includes('/node_modules/remark-') ||
              normalized.includes('/node_modules/rehype-') ||
              normalized.includes('/node_modules/unified/') ||
              normalized.includes('/node_modules/mdast-') ||
              normalized.includes('/node_modules/hast-') ||
              normalized.includes('/node_modules/micromark') ||
              normalized.includes('/node_modules/vfile') ||
              normalized.includes('/node_modules/unist-') ||
              normalized.includes('/node_modules/property-information/') ||
              normalized.includes('/node_modules/comma-separated-tokens/') ||
              normalized.includes('/node_modules/space-separated-tokens/') ||
              normalized.includes('/node_modules/decode-named-character-reference/') ||
              normalized.includes('/node_modules/character-entities/') ||
              normalized.includes('/node_modules/zwitch/') ||
              normalized.includes('/node_modules/bail/') ||
              normalized.includes('/node_modules/trough/') ||
              normalized.includes('/node_modules/is-plain-obj/') ||
              normalized.includes('/node_modules/devlop/') ||
              normalized.includes('/node_modules/estree-util-') ||
              normalized.includes('/node_modules/trim-lines/') ||
              normalized.includes('/node_modules/markdown-table/') ||
              normalized.includes('/node_modules/ccount/') ||
              normalized.includes('/node_modules/escape-string-regexp/') ||
              normalized.includes('/node_modules/longest-streak/')
            ) {
              return 'vendor-markdown';
            }
            if (
              normalized.includes('/node_modules/lucide-react/') ||
              normalized.includes('/node_modules/qrcode.react/')
            ) {
              return 'vendor-icons';
            }
            return 'vendor-misc';
          }

          if (
            normalized.includes('/packages/web/src/components/StudioModals.tsx') ||
            normalized.includes('/packages/web/src/components/SessionExplorerModal.tsx') ||
            normalized.includes('/packages/web/src/components/WorktreeManagerModal.tsx') ||
            normalized.includes('/packages/web/src/components/PluginAuthoringForm.tsx') ||
            normalized.includes('/packages/web/src/components/PluginDraftReview.tsx') ||
            normalized.includes('/packages/web/src/components/PluginDevPanel.tsx') ||
            normalized.includes('/packages/web/src/components/PluginPermissionsEditor.tsx') ||
            normalized.includes('/packages/web/src/components/PluginLogsPanel.tsx') ||
            normalized.includes('/packages/web/src/components/PluginDataPanel.tsx') ||
            normalized.includes('/packages/web/src/components/PluginPanels.tsx') ||
            normalized.includes('/packages/web/src/components/InspectorDrawer.tsx') ||
            normalized.includes('/packages/web/src/components/DiffInspectorPanel.tsx') ||
            normalized.includes('/packages/web/src/components/OrchestratorBoard.tsx') ||
            normalized.includes('/packages/web/src/components/TerminalWorkspaceDrawer.tsx') ||
            normalized.includes('/packages/web/src/components/ContextCompressionPanel.tsx') ||
            normalized.includes('/packages/web/src/components/SideChatDrawer.tsx') ||
            normalized.includes('/packages/web/src/components/TriageInbox.tsx') ||
            normalized.includes('/packages/web/src/components/ApprovalCenter.tsx') ||
            normalized.includes('/packages/web/src/components/MessageStudio.tsx') ||
            normalized.includes('/packages/web/src/components/HtmlRenderCard.tsx') ||
            normalized.includes('/packages/web/src/components/CheckpointControls.tsx') ||
            normalized.includes('/packages/web/src/components/TraitsPicker.tsx')
          ) {
            return 'app-features';
          }

          return undefined;
        },
      },
    },
  },
});
