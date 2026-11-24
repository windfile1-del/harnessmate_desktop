interface CompositionKey {
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  keyCode: number;
}

export function isImeComposing(event: CompositionKey, composing: boolean): boolean {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || composing || event.keyCode === 229);
}

export function trackComposition(target: EventTarget, composing: { current: boolean }): () => void {
  const start = () => { composing.current = true; };
  const end = () => { composing.current = false; };
  const options = { capture: true };
  target.addEventListener('compositionstart', start, options);
  target.addEventListener('compositionend', end, options);
  return () => {
    target.removeEventListener('compositionstart', start, options);
    target.removeEventListener('compositionend', end, options);
    composing.current = false;
  };
}
