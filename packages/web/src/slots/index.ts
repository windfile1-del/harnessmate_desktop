export {
  SlotRegistry,
  slotRegistry,
  type RegisteredSlotItem,
  type SlotItemRegistration,
  type SlotPropsMap,
  type SlotQueryOptions,
  type SlotSourceKind,
} from './slot-registry';
export {
  SlotRegistryProvider,
  SlotSessionProvider,
  SlotTurnProvider,
  useRequiredSession,
  useSession,
  useSlotItems,
  useSlotRegistry,
  useSlotRenderFailures,
  useSlotTheme,
  useTurn,
} from './hooks';
export { Slot, SlotErrorBoundary, type SlotProps } from './SlotRenderer';
export { SandboxedPluginFrame, type SandboxedPluginFrameProps } from './SandboxedPluginFrame';
export { PluginSlotSync } from './PluginSlotSync';
export {
  THEME_CSS_VAR_NAMES,
  buildIframeSrcDoc,
  collectThemeCssVars,
  toPublicSessionDto,
} from './sandbox-iframe-utils';
