/** Options for creating or mounting a kernel-managed desktop view. */
export interface DesktopViewCreateOptions {
  url: string;
  width?: number;
  height?: number;
  title?: string;
}

export interface DesktopViewResizeOptions {
  width: number;
  height: number;
}

export type DesktopViewInput =
  | { type: 'click' | 'move'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' |
      'Left' | 'Right' | 'Up' | 'Down' | 'Home' | 'End' | 'PageUp' | 'PageDown' }
  | { type: 'text'; text: string };

export interface DesktopViewFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export interface DesktopViewStatus {
  state: 'loading' | 'ready' | 'error' | 'closed';
  url?: string;
  message?: string;
}

export interface DesktopViewBridge {
  readonly available: boolean;
  create(options: DesktopViewCreateOptions): Promise<void>;
  mount(options: DesktopViewCreateOptions): Promise<void>;
  navigate(url: string): Promise<void>;
  resize(options: DesktopViewResizeOptions): Promise<void>;
  focus(focused?: boolean): Promise<void>;
  input(event: DesktopViewInput): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  destroy(): Promise<void>;
  onFrame(listener: (frame: DesktopViewFrame) => void): () => void;
  onStatus(listener: (status: DesktopViewStatus) => void): () => void;
}
