import { isImeComposing } from './ime';

export function handlePaletteKey(
  event: Parameters<typeof isImeComposing>[0] & {
    key: string;
    preventDefault(): void;
    stopPropagation(): void;
  },
  composing: boolean,
  actions: { move: (direction: -1 | 1) => void; execute: () => void; close: () => void },
): void {
  if (isImeComposing(event, composing)) return;
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowDown':
      event.preventDefault();
      event.stopPropagation();
      actions.move(event.key === 'ArrowUp' ? -1 : 1);
      break;
    case 'Enter':
      event.preventDefault();
      event.stopPropagation();
      actions.execute();
      break;
    case 'Escape':
      event.preventDefault();
      event.stopPropagation();
      actions.close();
      break;
  }
}
