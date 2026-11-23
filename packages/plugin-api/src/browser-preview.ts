/** An HTTP(S) page rendered by the desktop host in a private Chromium session. */
export interface PluginBrowserOptions {
  url: string;
  width?: number;
  height?: number;
}

export type PluginBrowserInput =
  | { type: 'click' | 'move'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' |
      'Left' | 'Right' | 'Up' | 'Down' | 'Home' | 'End' | 'PageUp' | 'PageDown' }
  | { type: 'text'; text: string };

export interface PluginBrowserFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export interface PluginBrowserStatus {
  state: 'loading' | 'ready' | 'error' | 'closed';
  url?: string;
  message?: string;
}

export interface PluginBrowserBridge {
  available: boolean;
  open(options: PluginBrowserOptions): Promise<void>;
  close(): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  input(event: PluginBrowserInput): Promise<void>;
  onFrame(listener: (frame: PluginBrowserFrame) => void): () => void;
  onStatus(listener: (status: PluginBrowserStatus) => void): () => void;
}
