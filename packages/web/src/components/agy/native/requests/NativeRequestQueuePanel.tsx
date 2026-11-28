import type { NativeRequestQueuePanelProps } from '../../../../plugins/requests-view-default/native/NativeRequestQueuePanel';
export type { NativeRequestQueuePanelProps };
/** Compatibility location in the AGY workbench: no request queue implementation or resolver. */
export function NativeRequestQueuePanel(_props: NativeRequestQueuePanelProps) {
  return <p className="text-[12px]">原生交互请求由当前绑定的请求视图显示和处理。</p>;
}
