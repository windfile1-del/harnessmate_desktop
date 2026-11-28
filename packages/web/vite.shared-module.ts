import type { Plugin } from 'vite';

/**
 * Maps shared public frontend dependencies (React, ReactDOM, Zustand)
 * to `window.__HARNESSMATE_PLUGIN_RUNTIME__` when compiling trusted plugin frontend modules.
 * Icons (`lucide-react`) stay tree-shaken per module so the host never bundles all icons.
 */
const SHARED_MODULE_MAP: Record<string, string> = {
  react: 'react',
  'react-dom': 'reactDom',
  'react-dom/client': 'reactDomClient',
  'react/jsx-runtime': 'reactJsxRuntime',
  'react/jsx-dev-runtime': 'reactJsxRuntime',
  zustand: 'zustand',
  'zustand/react/shallow': 'zustandShallow',
};

const VIRTUAL_PREFIX = '\0hm-shared:';

export function trustedModuleExternalsPlugin(): Plugin {
  return {
    name: 'hm-trusted-module-externals',
    enforce: 'pre',
    resolveId(source) {
      if (Object.hasOwn(SHARED_MODULE_MAP, source)) {
        return VIRTUAL_PREFIX + source;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const spec = id.slice(VIRTUAL_PREFIX.length);
      if (!SHARED_MODULE_MAP[spec]) return null;
      if (spec === 'react') {
        return `
const m = window.__HARNESSMATE_PLUGIN_RUNTIME__.react;
export default m;
export const {
  Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense,
  cache, cloneElement, createContext, createElement, createRef, forwardRef,
  isValidElement, lazy, memo, startTransition, use, useActionState, useCallback,
  useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle,
  useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef,
  useState, useSyncExternalStore, useTransition, version,
} = m;
`;
      }
      if (spec === 'react/jsx-runtime' || spec === 'react/jsx-dev-runtime') {
        return `
const m = window.__HARNESSMATE_PLUGIN_RUNTIME__.reactJsxRuntime;
export default m;
export const { Fragment, jsx, jsxs } = m;
export const jsxDEV = m.jsxDEV ?? m.jsx;
`;
      }
      if (spec === 'react-dom') {
        return `
const m = window.__HARNESSMATE_PLUGIN_RUNTIME__.reactDom;
export default m;
export const { createPortal, flushSync, preconnect, prefetchDNS, preinit, preinitModule, preload, preloadModule, version } = m;
`;
      }
      if (spec === 'react-dom/client') {
        return `
const m = window.__HARNESSMATE_PLUGIN_RUNTIME__.reactDomClient;
export default m;
export const { createRoot, hydrateRoot } = m;
`;
      }
      if (spec === 'zustand') {
        return `
const m = window.__HARNESSMATE_PLUGIN_RUNTIME__.zustand;
export default m;
export const { create, createStore, useStore } = m;
`;
      }
      if (spec === 'zustand/react/shallow') {
        return `
const m = window.__HARNESSMATE_PLUGIN_RUNTIME__.zustandShallow;
export default m;
export const { useShallow } = m;
`;
      }
      return null;
    },
  };
}
