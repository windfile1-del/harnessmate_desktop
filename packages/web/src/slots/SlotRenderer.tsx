import { PLUGIN_UI_SLOTS, type PluginSlotKey } from '@harnessmate/protocol';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { useSession, useSlotItems, useSlotRegistry } from './hooks';
import type { RegisteredSlotItem, SlotPropsMap, SlotRegistry } from './slot-registry';

interface SlotErrorBoundaryProps {
  registry: SlotRegistry;
  item: Pick<RegisteredSlotItem, 'pluginId' | 'pluginName' | 'slot' | 'id' | 'title'>;
  fallbackOnError?: ReactNode;
  compact?: boolean;
  children: ReactNode;
}

interface SlotErrorBoundaryState {
  error: Error | null;
}

export class SlotErrorBoundary extends Component<SlotErrorBoundaryProps, SlotErrorBoundaryState> {
  override state: SlotErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SlotErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    const { registry, item } = this.props;
    registry.reportRenderFailure({
      pluginId: item.pluginId,
      pluginName: item.pluginName,
      slot: item.slot,
      slotItemId: item.id,
      message: error.message || String(error),
    });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallbackOnError !== undefined) {
      return this.props.fallbackOnError;
    }
    const { item, compact } = this.props;
    if (compact) {
      return (
        <span
          role="alert"
          title={`${item.pluginName} (${item.slot}/${item.id}) 渲染异常：${error.message}`}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--accent-rose)]"
          style={{
            backgroundColor: 'var(--accent-rose-soft)',
            border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
          }}
        >
          <AlertTriangle size={11} />
          <span className="max-w-[120px] truncate">{item.title ?? item.pluginName} 异常</span>
        </span>
      );
    }
    return (
      <div
        role="alert"
        className="space-y-1.5 rounded-xl p-2.5 text-[11.5px] text-[var(--accent-rose)]"
        style={{
          backgroundColor: 'var(--accent-rose-soft)',
          border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <AlertTriangle size={13} />
            <span>{item.title ?? item.pluginName} 渲染失败</span>
          </span>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] hover:bg-[var(--bg-hover)]"
            style={{ border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)' }}
          >
            <RotateCcw size={10.5} />
            重试
          </button>
        </div>
        <p className="break-words text-[11px] opacity-90">{error.message}</p>
      </div>
    );
  }
}

function SlotItemRender<K extends PluginSlotKey>({
  item,
  props,
}: {
  item: RegisteredSlotItem<K>;
  props: SlotPropsMap[K];
}) {
  return <>{item.render(props)}</>;
}

export interface SlotProps<K extends PluginSlotKey> {
  name: K;
  slotProps: SlotPropsMap[K];
  matchKey?: string;
  fallback?: ReactNode;
  compactErrors?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Slot<K extends PluginSlotKey>({
  name,
  slotProps,
  matchKey,
  fallback = null,
  compactErrors = false,
  className,
  children,
}: SlotProps<K>) {
  const registry = useSlotRegistry();
  const session = useSession();
  const contract = PLUGIN_UI_SLOTS[name];
  const items = useSlotItems(name, matchKey);

  if (contract.scope === 'session' && !session) {
    return <>{contract.cardinality === 'hoc' ? children : fallback}</>;
  }

  if (contract.cardinality === 'single') {
    const winner = items[0];
    if (!winner) return <>{fallback}</>;
    return (
      <SlotErrorBoundary
        key={winner.registrationKey}
        registry={registry}
        item={winner}
        compact={compactErrors}
      >
        <SlotItemRender item={winner} props={slotProps} />
      </SlotErrorBoundary>
    );
  }

  if (contract.cardinality === 'list' || contract.cardinality === 'keyed') {
    if (items.length === 0) return <>{fallback}</>;
    const rendered = items.map((item) => (
      <SlotErrorBoundary
        key={item.registrationKey}
        registry={registry}
        item={item}
        compact={compactErrors}
      >
        <SlotItemRender item={item} props={slotProps} />
      </SlotErrorBoundary>
    ));
    return className ? <div className={className}>{rendered}</div> : <Fragment>{rendered}</Fragment>;
  }

  if (contract.cardinality === 'chain') {
    for (const item of items) {
      try {
        const result = item.render(slotProps);
        if (result !== null && result !== undefined && result !== false) {
          return (
            <SlotErrorBoundary
              key={item.registrationKey}
              registry={registry}
              item={item}
              compact={compactErrors}
            >
              {result}
            </SlotErrorBoundary>
          );
        }
      } catch (err) {
        registry.reportRenderFailure({
          pluginId: item.pluginId,
          pluginName: item.pluginName,
          slot: item.slot,
          slotItemId: item.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return <>{fallback}</>;
  }

  // hoc cardinality: wrap children from innermost to outermost, each isolated so a faulty wrapper preserves children
  if (items.length === 0) return <>{children}</>;
  let wrapped: ReactNode = children;
  for (let idx = items.length - 1; idx >= 0; idx -= 1) {
    const item = items[idx]!;
    const inner = wrapped;
    const propsWithChildren = {
      ...(slotProps as Record<string, unknown>),
      children: inner,
    } as SlotPropsMap[K];
    wrapped = (
      <SlotErrorBoundary
        key={item.registrationKey}
        registry={registry}
        item={item}
        fallbackOnError={inner}
      >
        <SlotItemRender item={item} props={propsWithChildren} />
      </SlotErrorBoundary>
    );
  }
  return <>{wrapped}</>;
}
