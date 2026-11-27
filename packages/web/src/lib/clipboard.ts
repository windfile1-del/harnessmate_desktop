export function copyText(text: string): Promise<void> {
  const bridge = (window as unknown as { harnessMate?: { call: (method: string, params: unknown) => Promise<void> } }).harnessMate;
  return bridge ? bridge.call('clipboard.writeText', { text }) : navigator.clipboard.writeText(text);
}
