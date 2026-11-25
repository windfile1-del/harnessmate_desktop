/**
 * Pure, framework-agnostic keyboard & modal focus utilities for AGY Native Workbench (03a / R4).
 *
 * Covers:
 * - Collecting visible, enabled focusable descendants inside a modal dialog container
 * - Trapping Tab / Shift+Tab within a narrow-viewport sheet
 * - Redirecting stray background focusin back into the active modal sheet
 * - Computing ArrowLeft / ArrowRight / Home / End target indices for ARIA tablists
 * - Guarding Escape against IME composition, defaultPrevented, or nested popovers/dialogs
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return candidates.filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.tabIndex < 0) return false;
    if (el.hasAttribute('hidden')) return false;
    return true;
  });
}

export function focusFirstInContainer(
  container: HTMLElement | null,
  preferred?: HTMLElement | null,
): HTMLElement | null {
  if (preferred && container?.contains(preferred) && !preferred.hasAttribute('disabled')) {
    preferred.focus();
    return preferred;
  }
  const focusables = getFocusableElements(container);
  const target = focusables[0] ?? container;
  if (target) target.focus();
  return target ?? null;
}

export function handleDialogTabTrap(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
  container: HTMLElement | null,
  activeElement: Element | null,
): HTMLElement | null {
  if (event.key !== 'Tab' || !container) return null;
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) {
    event.preventDefault();
    container.focus();
    return container;
  }

  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const inside = activeElement ? container.contains(activeElement) : false;

  if (!inside) {
    event.preventDefault();
    const target = event.shiftKey ? last : first;
    target.focus();
    return target;
  }

  if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
    return last;
  }

  if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
    return first;
  }

  return null;
}

export function computeNextTabIndex(
  key: string,
  currentIndex: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  const safeIdx = currentIndex < 0 ? 0 : currentIndex;
  switch (key) {
    case 'ArrowRight':
      return (safeIdx + 1) % total;
    case 'ArrowLeft':
      return (safeIdx - 1 + total) % total;
    case 'Home':
      return 0;
    case 'End':
      return total - 1;
    default:
      return null;
  }
}

export function shouldWorkbenchHandleEscape(
  event: {
    key: string;
    defaultPrevented: boolean;
    isComposing?: boolean;
    target?: EventTarget | null;
  },
  shellContainer: HTMLElement | null,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  // Do not hijack Escape when a nested listbox/menu/combobox popover is open
  const targetEl =
    event.target && typeof (event.target as Element).closest === 'function'
      ? (event.target as Element)
      : null;
  if (targetEl?.closest('[role="listbox"], [role="menu"]')) return false;
  if (shellContainer?.querySelector('[role="listbox"], [role="menu"]')) return false;
  // Do not close beneath a separate top-level modal dialog outside the shell
  if (typeof document !== 'undefined') {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'));
    const hasExternalModal = dialogs.some(
      (dlg) => dlg !== shellContainer && (!shellContainer || !shellContainer.contains(dlg)),
    );
    if (hasExternalModal) return false;
  }
  return true;
}
