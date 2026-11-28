import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as Zustand from 'zustand';
import * as ZustandShallow from 'zustand/react/shallow';

/**
 * Public shared frontend dependency table exposed to trusted frontend plugin modules.
 * Deliberately excludes host private stores (`useAppStore`), internal daemon clients,
 * and non-tree-shakeable icon barrels (`lucide-react`).
 */
export interface HarnessMateSharedFrontendRuntime {
  readonly version: '1.0.0';
  readonly react: typeof React;
  readonly reactDom: typeof ReactDom;
  readonly reactDomClient: typeof ReactDomClient;
  readonly reactJsxRuntime: typeof ReactJsxRuntime;
  readonly zustand: typeof Zustand;
  readonly zustandShallow: typeof ZustandShallow;
}

const SHARED_RUNTIME: HarnessMateSharedFrontendRuntime = Object.freeze({
  version: '1.0.0',
  react: React,
  reactDom: ReactDom,
  reactDomClient: ReactDomClient,
  reactJsxRuntime: ReactJsxRuntime,
  zustand: Zustand,
  zustandShallow: ZustandShallow,
});

declare global {
  interface Window {
    __HARNESSMATE_PLUGIN_RUNTIME__?: HarnessMateSharedFrontendRuntime;
  }
}

export function ensureSharedPluginRuntime(): HarnessMateSharedFrontendRuntime {
  if (typeof window !== 'undefined' && !window.__HARNESSMATE_PLUGIN_RUNTIME__) {
    Object.defineProperty(window, '__HARNESSMATE_PLUGIN_RUNTIME__', {
      value: SHARED_RUNTIME,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
  return SHARED_RUNTIME;
}
