import { BoundSessionSurface, useBoundSessionPlugin } from '../../slots/BoundSessionSurface';
import { useShallow } from 'zustand/react/shallow';
import type {
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  FailoverPolicy,
  HarnessAccountUsage,
  HarnessCommandInfo,
  HarnessInfo,
  PermissionMode,
  ReasoningEffort,
  Session,
  SessionModelPluginTools,
  SessionPluginAction,
  TerminalContextChip,
  TurnBlockRecord,
  TurnOptionValue,
  WorkspaceFileEntry,
} from '@harnessmate/protocol';
import { HarnessCommandNameSchema, ReasoningEffortSchema } from '@harnessmate/protocol';
import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowRightLeft,
  ArrowUp,
  AtSign,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FileCode2,
  FileText,
  FolderGit2,
  GitBranch,
  GitFork,
  GitMerge,
  Globe,
  ImagePlus,
  ListChecks,
  Loader2,
  PanelLeft,
  PanelRight,
  Paperclip,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Slash,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { daemonApi, resolveAttachmentUrl } from '../../api/client';
import { bridge } from './transport';
import { AttachmentImage } from './AttachmentImage';
import { copyText } from '../../lib/clipboard';
import {
  AGY_WORKBENCH_CONTRACT,
  SESSION_ATTACHMENTS_CONTRACT,
  WORKSPACE_FILES_CONTRACT,
  isContractAvailableClientSide,
} from '../../api/peer-contracts';
import { formatPluginSummary, listPluginPanels } from '../../lib/plugin-panels';
import {
  formatTokenCount,
  PERMISSION_MODE_LABELS,
  resolveContextWindowMeter,
  resolveHarnessMeta,
  resolveHarnessOptionDescriptors,
} from '../../lib/harness-meta';
import {
  createSessionEventProjector,
  mergeTurnBlockRecords,
  type ProjectedSwitchEvent,
  type ProjectedToolCall,
  type ProjectedTurn,
} from './projector';
import {
  buildTimelineMinimapItems,
  groupTurnBlocks,
  isExtensionOrUnknownBlock,
  readTimelinePosition,
  rememberTimelinePosition,
} from './work-groups';
import { useAppStore } from './store';
import type { FileLink } from '../../lib/file-links';
import { Slot, SlotTurnProvider } from '../../slots';
import {
  DEFAULT_WORKBENCH_ROUTE,
  EntityStatusBadge,
  NativeActivityLink,
  resolveAgyModeOptions,
} from '../../components/agy/native/shared';
import type { WorkflowId } from '../../lib/native-client';
import {
  ComposerPendingRequestBar,
  GlobalAttentionStrip,
  RuntimeRequestReceiptBlock,
} from '../../components/ApprovalCenter';
import { HarnessBadge, StarLoomCrest } from '../../components/BrandMark';
import { UndoRevertBanner } from '../../components/CheckpointControls';
import { HarnessSwitcher } from '../../components/HarnessSwitcher';
import { HtmlRenderCard } from '../../components/HtmlRenderCard';

import { MarkdownView } from '../../components/MarkdownView';
import { StudioExtension, StudioMinimap, StudioScope, StudioWorkGroup } from '../../slots/StudioSurfaces';
import { ModelPicker } from '../../components/ModelPicker';
import { FailoverInlineBanner } from '../../components/FailoverInlineBanner';
import { ComposerPendingTerminalContexts } from '../../components/TerminalContextInlineChip';
import {
  loadSavedTraitValues,
  sanitizeTraitValues,
  TraitsPicker,
} from '../../components/TraitsPicker';

const DRIVER_LABELS: Record<string, string> = {
  native_items: '原生结构化历史注入 (native_items)',
  embedded_context: '原生嵌入式资源上下文 (embedded_context)',
  sysfile_delta: '系统约束 + 增量同步通道 (sysfile_delta)',
  inline: '结构化上下文信封 (inline)',
  codex_inject_items: '原生历史注入 (native_items)',
  acp_embedded_context: 'ACP 原生资源块 (embeddedContext)',
  claude_sysfile_delta: '系统约束 + 增量同步通道',
  prompt_envelope: '结构化上下文信封',
  native_warm: '原生热记忆（零重传）',
};
const NO_ATTACHMENTS: Attachment[] = [];
const NO_TERMINAL_CHIPS: TerminalContextChip[] = [];
const NO_EVENTS: CanonicalEvent[] = [];
const NO_TURN_ITEMS: TurnBlockRecord[] = [];
const TIMELINE_PAGE_SIZE = 80;

function SessionUndoRevertBar({ sessionId }: { sessionId: string }) {
  const lastRevert = useAppStore((s) => s.lastRevertBySession[sessionId]);
  const revertCheckpoint = useAppStore((s) => s.revertCheckpoint);
  const clearLastRevert = useAppStore((s) => s.clearLastRevert);
  const [undoing, setUndoing] = useState(false);

  if (!lastRevert) return null;

  return (
    <div className="shrink-0 px-4 pt-2.5">
      <div className="mx-auto max-w-[760px]">
        <UndoRevertBanner
          revertResult={lastRevert}
          undoing={undoing}
          onUndo={async () => {
            setUndoing(true);
            try {
              await revertCheckpoint(sessionId, {
                checkpointId: lastRevert.preRevertCheckpointId,
                mode: 'files_only',
              });
              clearLastRevert(sessionId);
            } finally {
              setUndoing(false);
            }
          }}
          onDismiss={() => clearLastRevert(sessionId)}
        />
      </div>
    </div>
  );
}

export function ChatStage() {
  const {
    sessions,
    pendingApprovals,
    harnesses,
    workspaces,
    slashCommands,
    plugins,
    pluginPermissionRevision,
    focusedTurn,
    focusTurn,
    selectedSessionId,
    events,
    turnItems,
    accountUsage,
    failoverPolicy,
    traitsByScope,
    setTraitValue,
    selectedTaskState,
    selectedContextPreview,
    selectedDraft,
    selectedAttachments,
    selectedPendingTerminalChips,
    sidebarCollapsed,
    inspectorOpen,
    setSidebarCollapsed,
    setInspectorOpen,
    setInspectorTab,
    openInspectorFile,
    openModal,
    selectSession,
    sendTurn,
    runHarnessCommand,
    runPluginAction,
    switchHarness,
    failoverSession,
    interruptSession,
    updateSession,
    resolveApproval,
    resolveRuntimeRequest,
    forkSession,
    mergeBackSession,
    setDraftText,
    addDraftAttachment,
    removeDraftAttachment,
    removePendingTerminalChip,
    clearDraft,
    pushToast,
    isPluginEnabled,
    compositionEntries,
    compositionBindings,
    workspaceBindingsByWorkspace,
    sessionBindingsBySession,
    agyNativeWorkbenchEnabled,
    selectedNativeRuntime,
    agyAuthStates,
    setNativeWorkbenchRoute,
    hydrateNativeRuntime,
    submitNativeCommand,
    dispatchNativeControl,
    loadNativeTimeline,
    loadNativeWorkflowResource,
  } = useAppStore(useShallow((state) => ({
    sessions: state.sessions,
    pendingApprovals: state.pendingApprovals,
    harnesses: state.harnesses,
    workspaces: state.workspaces,
    slashCommands: state.slashCommands,
    plugins: state.plugins,
    pluginPermissionRevision: state.pluginPermissionRevision,
    focusedTurn: state.focusedTurn,
    focusTurn: state.focusTurn,
    selectedSessionId: state.selectedSessionId,
    events: state.selectedSessionId ? state.eventsBySession[state.selectedSessionId] : undefined,
    turnItems: state.selectedSessionId ? state.turnItemsBySession[state.selectedSessionId] : undefined,
    accountUsage: state.accountUsage,
    failoverPolicy: state.failoverPolicy,
    traitsByScope: state.traitsByScope,
    setTraitValue: state.setTraitValue,
    selectedTaskState: state.selectedSessionId ? state.taskStateBySession[state.selectedSessionId] : undefined,
    selectedContextPreview: state.selectedSessionId ? state.contextPreviewBySession[state.selectedSessionId] : undefined,
    selectedDraft: state.selectedSessionId ? state.draftTextBySession[state.selectedSessionId] : undefined,
    selectedAttachments: state.selectedSessionId ? state.draftAttachmentsBySession[state.selectedSessionId] : undefined,
    selectedPendingTerminalChips: state.selectedSessionId ? state.pendingTerminalChipsBySession[state.selectedSessionId] : undefined,
    sidebarCollapsed: state.sidebarCollapsed,
    inspectorOpen: state.inspectorOpen,
    setSidebarCollapsed: state.setSidebarCollapsed,
    setInspectorOpen: state.setInspectorOpen,
    setInspectorTab: state.setInspectorTab,
    openInspectorFile: state.openInspectorFile,
    openModal: state.openModal,
    selectSession: state.selectSession,
    sendTurn: state.sendTurn,
    runHarnessCommand: state.runHarnessCommand,
    runPluginAction: state.runPluginAction,
    switchHarness: state.switchHarness,
    failoverSession: state.failoverSession,
    interruptSession: state.interruptSession,
    updateSession: state.updateSession,
    resolveApproval: state.resolveApproval,
    resolveRuntimeRequest: state.resolveRuntimeRequest,
    forkSession: state.forkSession,
    mergeBackSession: state.mergeBackSession,
    setDraftText: state.setDraftText,
    addDraftAttachment: state.addDraftAttachment,
    removeDraftAttachment: state.removeDraftAttachment,
    removePendingTerminalChip: state.removePendingTerminalChip,
    clearDraft: state.clearDraft,
    pushToast: state.pushToast,
    isPluginEnabled: state.isPluginEnabled,
    compositionEntries: state.compositionEntries,
    compositionBindings: state.compositionBindings,
    workspaceBindingsByWorkspace: state.workspaceBindingsByWorkspace,
    sessionBindingsBySession: state.sessionBindingsBySession,
    agyNativeWorkbenchEnabled: state.agyNativeWorkbenchEnabled,
    selectedNativeRuntime: state.selectedSessionId ? state.nativeRuntimeBySession[state.selectedSessionId] : undefined,
    agyAuthStates: state.agyAuthStates,
    setNativeWorkbenchRoute: state.setNativeWorkbenchRoute,
    hydrateNativeRuntime: state.hydrateNativeRuntime,
    submitNativeCommand: state.submitNativeCommand,
    dispatchNativeControl: state.dispatchNativeControl,
    loadNativeTimeline: state.loadNativeTimeline,
    loadNativeWorkflowResource: state.loadNativeWorkflowResource,
  })));

  const session = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const harness = useMemo(
    () => (session ? harnesses.find((h) => h.id === session.harnessId) ?? null : null),
    [harnesses, session],
  );

  // Background sessions awaiting approval (Global Attention Strip)
  const otherAwaitingSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          s.id !== selectedSessionId &&
          (s.status === 'awaiting_approval' || s.pendingApprovalCount > 0),
      ),
    [sessions, selectedSessionId],
  );

  const visibleEvents = events ?? NO_EVENTS;
  const visibleTurnItems = turnItems ?? NO_TURN_ITEMS;
  const taskState = selectedTaskState ?? null;
  const contextPreview = selectedContextPreview ?? null;
  const embeddedWorkbenchPlugin = useBoundSessionPlugin(AGY_WORKBENCH_CONTRACT, session);
  const embeddedWorkbenchSlot = embeddedWorkbenchPlugin?.contributes.slots?.find(
    (s) => s.slot === 'session.stage.embedded' && Boolean(s.ui),
  );
  const nativeWorkbenchActive = Boolean(
    session && embeddedWorkbenchPlugin && embeddedWorkbenchSlot,
  );
  const nativeProjection = nativeWorkbenchActive ? (selectedNativeRuntime?.projection ?? null) : null;
  const nativeSyncState = nativeWorkbenchActive ? (selectedNativeRuntime?.syncState ?? null) : null;
  const nativeCapabilities = nativeWorkbenchActive ? (selectedNativeRuntime?.capabilities ?? []) : [];
  const nativeRoute = nativeWorkbenchActive
    ? (selectedNativeRuntime?.route ?? DEFAULT_WORKBENCH_ROUTE)
    : DEFAULT_WORKBENCH_ROUTE;
  const nativeSelectedModeId = nativeWorkbenchActive
    ? (selectedNativeRuntime?.selectedModeId ?? 'normal')
    : 'normal';
  const nativeCommandSubmission = nativeWorkbenchActive
    ? (selectedNativeRuntime?.commandSubmission ?? null)
    : null;
  const nativeModeOptions = useMemo(() => {
    if (!nativeWorkbenchActive || !session) return [];
    const profileVerified =
      agyAuthStates[session.harnessId]?.phase === 'authenticated' ||
      Boolean(nativeProjection && nativeProjection.capabilitiesRevision > 0);
    return resolveAgyModeOptions(nativeCapabilities, profileVerified);
  }, [nativeWorkbenchActive, session, agyAuthStates, nativeProjection, nativeCapabilities]);
  const activeNativeMode = nativeModeOptions.find((m) => m.id === nativeSelectedModeId) ?? null;

  const stableLoadNativeTimeline = useCallback(
    (scope: { kind: 'activity' | 'agent'; id: string }, pageToken?: string | null, signal?: AbortSignal) =>
      loadNativeTimeline(selectedSessionId ?? '', scope, pageToken, signal),
    [selectedSessionId, loadNativeTimeline],
  );
  const stableLoadNativeWorkflowResource = useCallback(
    (workflowId: WorkflowId, resource: string, pageToken?: string | null, signal?: AbortSignal) =>
      loadNativeWorkflowResource(selectedSessionId ?? '', workflowId, resource, pageToken, signal),
    [selectedSessionId, loadNativeWorkflowResource],
  );

  // Only isolate legacy placeholder turns (`turn_bg`/`turn_unknown`) when a healthy live native projection replaces them
  const canIsolateNativePlaceholders = Boolean(
    nativeWorkbenchActive &&
      nativeProjection &&
      nativeSyncState?.phase === 'live' &&
      nativeProjection.activities.length > 0,
  );

  const project = useMemo(() => createSessionEventProjector(), [selectedSessionId]);
  const baseTimeline = project(
    visibleEvents,
    session ? { id: session.harnessId, kind: session.harnessKind } : undefined,
    { isolateNativePlaceholders: canIsolateNativePlaceholders },
  );
  const timeline = useMemo(
    () =>
      visibleTurnItems.length > 0
        ? mergeTurnBlockRecords(baseTimeline, visibleTurnItems)
        : baseTimeline,
    [baseTimeline, visibleTurnItems],
  );
  useEffect(() => {
    if (bridge) void bridge.call('presentation.publish', { diagnostics: timeline.diagnostics.slice(-200) }).catch(() => {});
  }, [timeline.diagnostics]);
  const minimapEntries = useMemo(
    () =>
      session
        ? buildTimelineMinimapItems(timeline.items, {
            id: session.harnessId,
            kind: session.harnessKind,
          })
        : [],
    [timeline.items, session],
  );
  const contextBridgeEnabled = isPluginEnabled('core.context-bridge');
  const taskLedgerEnabled = Boolean(useBoundSessionPlugin('session.ledger.v1', session ?? null));
  const nativeCommandsEnabled = isPluginEnabled('core.harness-commands');
  const explorerEnabled = isPluginEnabled('hm.plugin.session-explorer');
  const approvalCenterEnabled = isPluginEnabled('hm.plugin.approval-center');
  const sessionPendingRequests = useMemo(() => {
    if (!session) return [];
    const byId = new Map<string, ApprovalRequest>();
    for (const item of timeline.pendingApprovals) byId.set(item.id, item);
    for (const item of pendingApprovals) {
      if (item.sessionId === session.id && item.status === 'pending') {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()];
  }, [session, timeline.pendingApprovals, pendingApprovals]);
  const allGlobalPendingRequests = useMemo(() => {
    const byId = new Map<string, ApprovalRequest>();
    for (const item of pendingApprovals) {
      if (item.status === 'pending') byId.set(item.id, item);
    }
    for (const item of timeline.pendingApprovals) {
      if (item.status === 'pending') byId.set(item.id, item);
    }
    return [...byId.values()];
  }, [pendingApprovals, timeline.pendingApprovals]);
  const commandCatalogKey = session ? `${session.id}:${session.harnessId}` : '';

  const traitScopeKey = session ? `${session.id}:${session.harnessId}` : '';
  const instanceTraitScopeKey = session ? `instance:${session.harnessId}` : '';
  const activeOptionDescriptors = useMemo(
    () => resolveHarnessOptionDescriptors(harness, session?.model),
    [harness, session?.model],
  );
  const effectiveTraitValues = useMemo(() => {
    if (!session) return {};
    const fromInstance = traitsByScope[instanceTraitScopeKey] ?? loadSavedTraitValues(instanceTraitScopeKey);
    const fromSession = traitsByScope[traitScopeKey] ?? loadSavedTraitValues(traitScopeKey);
    const merged: Record<string, TurnOptionValue | undefined> = {
      ...fromInstance,
      ...fromSession,
    };
    if (session.reasoningEffort) {
      if (activeOptionDescriptors.some((d) => d.key === 'reasoningEffort')) {
        merged.reasoningEffort = session.reasoningEffort;
      } else if (activeOptionDescriptors.some((d) => d.key === 'effort')) {
        merged.effort = session.reasoningEffort;
      }
    }
    return sanitizeTraitValues(activeOptionDescriptors, merged);
  }, [session, traitsByScope, instanceTraitScopeKey, traitScopeKey, activeOptionDescriptors]);

  const handleTraitChange = useCallback(
    (key: string, value: TurnOptionValue | null) => {
      if (!session) return;
      setTraitValue(traitScopeKey, key, value);
      setTraitValue(instanceTraitScopeKey, key, value);
      if (key === 'reasoningEffort' || key === 'effort') {
        const parsedEffort =
          typeof value === 'string' ? ReasoningEffortSchema.safeParse(value) : null;
        void updateSession(session.id, {
          reasoningEffort: parsedEffort?.success ? parsedEffort.data : null,
        });
      }
    },
    [session, traitScopeKey, instanceTraitScopeKey, setTraitValue, updateSession],
  );

  const inputText = selectedDraft ?? '';
  const attachments = selectedAttachments ?? NO_ATTACHMENTS;
  const pendingTerminalChips = selectedPendingTerminalChips ?? NO_TERMINAL_CHIPS;

  const [sending, setSending] = useState(false);
  const [visibleHistory, setVisibleHistory] = useState<{ sessionId: string; count: number }>();
  const visibleCount = visibleHistory && visibleHistory.sessionId === selectedSessionId
    ? visibleHistory.count : TIMELINE_PAGE_SIZE;
  const firstVisible = Math.max(0, timeline.items.length - visibleCount);
  const [pluginModeSessions, setPluginModeSessions] = useState<ReadonlySet<string>>(() => new Set());
  const pluginMode = Boolean(session && pluginModeSessions.has(session.id));
  const openFile = useCallback(({ path, line }: FileLink) => {
    if (selectedSessionId) openInspectorFile(selectedSessionId, path, line);
  }, [selectedSessionId, openInspectorFile]);
  const onFailover = useCallback((targetHarnessId: string) => {
    if (selectedSessionId) void failoverSession(selectedSessionId, { targetHarnessId, retryLastFailedTurn: true });
  }, [selectedSessionId, failoverSession]);
  const [suggestion, setSuggestion] = useState<{ key: string; text: string; pluginNames: string[] }>();
  const suggestionKey = session ? JSON.stringify([session.id, session.harnessId, pluginMode, inputText, attachments.map(({ id }) => id)]) : '';
  const activeSuggestion = suggestion?.key === suggestionKey ? suggestion : undefined;
  const [omitHandoffFor, setOmitHandoffFor] = useState<string>();
  const handoffOmitted = Boolean(session && omitHandoffFor === `${session.id}:${session.harnessId}`);
  const [uploading, setUploading] = useState(false);
  const [draggingOver, setDraggingOver] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [commandCatalog, setCommandCatalog] = useState<{ key: string; commands: HarnessCommandInfo[];
    pluginActions: SessionPluginAction[]; modelTools: SessionModelPluginTools }>();
  const [commandOutputs, setCommandOutputs] = useState<Record<string, { command: string; output: string }>>({});

  // @file mention popover
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerItems, setFilePickerItems] = useState<WorkspaceFileEntry[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const previousHistoryHeight = useRef<number | null>(null);
  const followBottom = useRef(true);
  const previousSessionId = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workbenchTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingWorkbenchFocusRestoreRef = useRef(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 768px)');
    const onChange = (event: MediaQueryListEvent) => setIsNarrowViewport(event.matches);
    setIsNarrowViewport(mql.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  // Restore focus to the topbar trigger button once chat header remounts (including full-width -> chat close)
  useEffect(() => {
    if (nativeRoute.surface === 'chat' && pendingWorkbenchFocusRestoreRef.current) {
      if (workbenchTriggerRef.current) {
        pendingWorkbenchFocusRestoreRef.current = false;
        workbenchTriggerRef.current.focus();
      }
    }
  }, [nativeRoute.surface, nativeRoute.layout, isNarrowViewport]);

  useEffect(() => {
    const el = scrollRef.current;
    if (previousSessionId.current !== selectedSessionId) {
      previousSessionId.current = selectedSessionId;
      const saved = selectedSessionId ? readTimelinePosition(selectedSessionId) : null;
      if (saved && el) {
        followBottom.current = saved.followBottom;
        if (saved.followBottom) {
          el.scrollTop = el.scrollHeight;
        } else {
          el.scrollTop = saved.scrollTop;
        }
        return;
      }
      followBottom.current = true;
    }
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [visibleEvents.length, selectedSessionId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && previousHistoryHeight.current !== null) {
      el.scrollTop += el.scrollHeight - previousHistoryHeight.current;
      previousHistoryHeight.current = null;
    }
  }, [firstVisible]);

  useEffect(() => {
    if (!focusedTurn || focusedTurn.sessionId !== selectedSessionId) return;
    const itemTarget = focusedTurn.itemId
      ? document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(focusedTurn.itemId)}"]`)
      : null;
    const target = itemTarget ?? document.getElementById(`chat-turn-${focusedTurn.turnId}`);
    if (!target) {
      const index = timeline.items.findIndex((item) => item.kind === 'turn' && item.turnId === focusedTurn.turnId);
      if (index >= 0 && index < firstVisible) {
        setVisibleHistory({ sessionId: selectedSessionId, count: timeline.items.length - index });
      }
      return;
    }
    followBottom.current = false;
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
    focusTurn(null);
  }, [focusedTurn, selectedSessionId, timeline, focusTurn, firstVisible]);

  useEffect(() => {
    if (!selectedSessionId) return;
    let current = true;
    void daemonApi.getHarnessCommands(selectedSessionId).then((catalog) => {
      if (current) setCommandCatalog({ key: commandCatalogKey, ...catalog });
    }).catch(() => {});
    return () => { current = false; };
  }, [selectedSessionId, commandCatalogKey, session?.nativeSessionId, session?.status, plugins, pluginPermissionRevision]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [inputText, selectedSessionId]);

  // Trigger workspace file search when @file picker is open
  const filesEnabled = useMemo(
    () =>
      isContractAvailableClientSide({
        contract: WORKSPACE_FILES_CONTRACT,
        legacyPluginId: 'core.terminal-runner',
        plugins,
        sessionBindings: session ? sessionBindingsBySession[session.id] : undefined,
        workspaceBindings: session ? workspaceBindingsByWorkspace[session.workspaceId] : undefined,
        compositionBindings,
        compositionEntries,
      }),
    [plugins, session, sessionBindingsBySession, workspaceBindingsByWorkspace, compositionBindings, compositionEntries],
  );

  useEffect(() => {
    if (!filePickerOpen || !session || !filesEnabled) {
      if (!filesEnabled) setFilePickerItems([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void daemonApi
        .searchSessionFiles(session.id, filePickerQuery)
        .then((res) => {
          if (!cancelled) setFilePickerItems(res.files.slice(0, 14));
        })
        .catch(() => {});
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filePickerOpen, filePickerQuery, session, filesEnabled]);

  const nativeCommands = nativeCommandsEnabled && commandCatalog?.key === commandCatalogKey
    ? commandCatalog.commands : [];
  const pluginActions = commandCatalog?.key === commandCatalogKey ? commandCatalog.pluginActions ?? [] : [];
  const modelTools = commandCatalog?.key === commandCatalogKey ? commandCatalog.modelTools : undefined;
  const pluginPanels = useMemo(() => listPluginPanels(plugins), [plugins]);
  const panelCommands = useMemo(() => pluginPanels.flatMap((entry) => {
    const action = entry.panel.copySummary;
    return action?.command ? [{ ...entry, command: action.command, description: action.label,
      argumentHint: undefined, pluginName: entry.panel.title }] : [];
  }), [pluginPanels]);
  // The active CLI catalog takes precedence over workflow shortcuts of the same name.
  const slashMatches = useMemo(() => {
    const trimmed = inputText.trimStart();
    if (pluginMode || !trimmed.startsWith('/') || trimmed.includes('\n')) return [];
    const firstToken = trimmed.slice(1).split(/\s/)[0]?.toLowerCase() ?? '';
    if (trimmed.includes(' ')) return [];
    const native = nativeCommands.map((command) => ({
      ...command, pluginId: 'core.harness-commands', pluginName: harness?.displayName ?? '原生命令',
    }));
    const nativeNames = new Set<string>(native.map(({ command }) => command));
    const actions = pluginActions.map((entry) => ({ ...entry, description: entry.reason ? `${entry.description} · ${entry.reason}` : entry.description,
      argumentHint: entry.kind === 'program' ? '<文本>' : undefined }));
    return [...native, ...[...panelCommands, ...actions, ...slashCommands].filter(({ command }) => !nativeNames.has(command))]
      .filter((c) => c.command.toLowerCase().includes(firstToken));
  }, [inputText, nativeCommands, slashCommands, panelCommands, pluginActions, harness?.displayName, pluginMode]);

  if (!session) {
    return (
      <AtelierWelcome
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        harnesses={harnesses}
        hasWorkspaces={workspaces.length > 0}
        onStartHarness={(harnessId) => openModal('new_session', harnessId)}
        onAddWorkspace={() => openModal('add_workspace')}
        onOpenPlugins={() => openModal('plugins')}
        onOpenUsage={() => openModal('usage')}
        onOpenPairing={() => openModal('remote_pairing')}
      />
    );
  }

  const isRunning = session.status === 'running' || session.status === 'awaiting_approval';
  const permissionModes = new Set<PermissionMode>(harness?.capabilities.permissionModes ?? ['plan', 'accept_edits', 'auto']);
  permissionModes.add(session.permissionMode);
  const attachmentsEnabled = isContractAvailableClientSide({
    contract: SESSION_ATTACHMENTS_CONTRACT,
    legacyPluginId: 'core.attachments',
    plugins,
    sessionBindings: session ? sessionBindingsBySession[session.id] : undefined,
    workspaceBindings: session ? workspaceBindingsByWorkspace[session.workspaceId] : undefined,
    compositionBindings,
    compositionEntries,
  });
  const commandMatch = pluginMode ? null : /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(inputText.trim());
  const typedCommand = commandMatch?.[1]?.toLowerCase();
  const commandArgs = commandMatch?.[2]?.trim() ?? '';
  const nativeCommandName = HarnessCommandNameSchema.safeParse(
    typedCommand === 'quota' ? 'usage' : typedCommand === 'plugins' ? 'plugin' : typedCommand);
  const supportsGoalControl = Boolean(
    harness?.capabilitiesV2?.nativeCommands?.includes('goal') ||
      nativeCommands.some((c) => c.command === 'goal'),
  );
  const isGoalControl =
    nativeCommandsEnabled &&
    supportsGoalControl &&
    typedCommand === 'goal' &&
    ['', 'status', 'pause', 'clear'].includes(commandArgs);
  const canSteerActive = Boolean(
    isRunning &&
      session.status === 'running' &&
      harness?.capabilitiesV2?.supportsActiveSteering,
  );
  const contextMeter = resolveContextWindowMeter(session.usage);

  const handleUploadFiles = async (fileList: FileList | File[]) => {
    const filesArr = Array.from(fileList);
    if (filesArr.length === 0) return;
    setUploading(true);
    try {
      for (const file of filesArr) {
        const isImage = file.type.startsWith('image/');
        const base64 = await readFileAsBase64(file);
        const { attachment } = await daemonApi.uploadAttachment(session.id, {
          name: file.name || (isImage ? `screenshot-${Date.now()}.png` : `file-${Date.now()}`),
          kind: isImage ? 'image' : 'file_ref',
          mimeType: file.type || (isImage ? 'image/png' : 'application/octet-stream'),
          dataBase64: base64,
        });
        addDraftAttachment(session.id, attachment);
      }
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '添加附件失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled) return;
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void handleUploadFiles(files);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingOver(false);
    if (!attachmentsEnabled) return;
    if (e.dataTransfer.files?.length > 0) {
      void handleUploadFiles(e.dataTransfer.files);
    }
  };

  const handleInputChange = (val: string) => {
    setDraftText(session.id, val);
    // Open @file picker when user types "@" followed by non-space token at end
    const atMatch = val.match(/(?:^|\s)@([^\s@]*)$/);
    if (atMatch) {
      setFilePickerOpen(true);
      setFilePickerQuery(atMatch[1] ?? '');
    } else if (filePickerOpen) {
      setFilePickerOpen(false);
    }
  };

  const handleSelectMentionFile = (entry: WorkspaceFileEntry) => {
    const cleaned = inputText.replace(/(?:^|\s)@([^\s@]*)$/, (m) => (m.startsWith(' ') ? ' ' : ''));
    setDraftText(session.id, cleaned);
    setFilePickerOpen(false);
    addDraftAttachment(session.id, {
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      kind: 'file_ref',
      name: entry.name,
      path: entry.fullPath,
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
    });
    textareaRef.current?.focus();
  };

  const handleSend = async (suggestionChoice?: 'apply' | 'original') => {
    const trimmed = inputText.trim();
    if ((!trimmed && attachments.length === 0 && pendingTerminalChips.length === 0) || sending || (isRunning && !isGoalControl && !canSteerActive) ||
      (activeSuggestion && !suggestionChoice)) return;
    if (
      nativeWorkbenchActive &&
      activeNativeMode &&
      activeNativeMode.id !== 'normal' &&
      activeNativeMode.capabilityId
    ) {
      if (activeNativeMode.gate !== 'available') {
        pushToast({
          kind: 'warning',
          title: `${activeNativeMode.label} 当前不可运行`,
          body: `${activeNativeMode.sourceNote} · 官方入口：${activeNativeMode.officialEntry}`,
        });
        return;
      }
      setSending(true);
      const sentAttIds = attachments.map((a) => a.id);
      const sentChipIds = pendingTerminalChips.map((c) => c.id);
      try {
        const ok = await submitNativeCommand(session.id, {
          capabilityId: activeNativeMode.capabilityId,
          actionKey: activeNativeMode.id,
          expectedBinding: nativeProjection?.binding,
          expectedCapabilitiesRevision: nativeProjection?.capabilitiesRevision,
          args: {
            prompt: trimmed,
            ...(sentAttIds.length > 0 ? { attachmentIds: sentAttIds } : {}),
            ...(sentChipIds.length > 0 ? { terminalContextIds: sentChipIds } : {}),
          },
        });
        if (ok) {
          const curState = useAppStore.getState();
          if (curState.draftTextBySession[session.id] === inputText) {
            setDraftText(session.id, '');
          }
          // Only remove attachments/chips that were actually part of this submission; preserve mid-flight additions
          for (const attId of sentAttIds) {
            removeDraftAttachment(session.id, attId);
          }
          for (const chipId of sentChipIds) {
            removePendingTerminalChip(session.id, chipId);
          }
        }
      } finally {
        setSending(false);
        textareaRef.current?.focus();
      }
      return;
    }
    const panelCommand = nativeCommands.some(({ command }) => command === typedCommand) ? undefined
      : panelCommands.find(({ command }) => command === typedCommand);
    if (panelCommand) {
      if (commandArgs || attachments.length > 0) {
        pushToast({ kind: 'warning', title: `请单独发送 /${panelCommand.command}` });
        return;
      }
      setSending(true);
      try {
        const { panel, pluginId } = panelCommand;
        const snapshot = await daemonApi.getPluginPanel(session.id, pluginId, panel.id);
        await copyText(formatPluginSummary(panel.title, snapshot));
        if (useAppStore.getState().draftTextBySession[session.id] === inputText) clearDraft(session.id);
        pushToast({ kind: 'success', title: '已复制轮次摘要' });
      } catch (err) {
        pushToast({ kind: 'error', title: '插件命令执行失败', body: err instanceof Error ? err.message : String(err) });
      } finally {
        setSending(false);
        textareaRef.current?.focus();
      }
      return;
    }
    const name = nativeCommandName;
    const isWorkflow = slashCommands.some((command) => command.command === typedCommand);
    const pluginAction = pluginActions.find(({ command }) => command === typedCommand);
    const actionCommand = pluginAction?.command ?? plugins.filter(({ enabled }) => enabled)
      .flatMap(({ contributes }) => contributes.actions ?? []).find(({ command }) => command === typedCommand)?.command;
    const nativeCommand = nativeCommandsEnabled && name.success && (!isWorkflow || nativeCommands.some((command) => command.command === name.data))
      ? name.data : undefined;
    if (actionCommand || nativeCommand) {
      if (pluginAction?.reason && !nativeCommand) {
        pushToast({ kind: 'warning', title: '当前会话无法执行插件动作', body: pluginAction.reason });
        return;
      }
      if (attachments.length > 0) {
        pushToast({ kind: 'warning', title: '请先移除附件再执行命令' });
        return;
      }
      setSending(true);
      try {
        const input = { args: commandArgs, harnessId: session.harnessId };
        const response = nativeCommand ? await runHarnessCommand(session.id, { ...input, command: nativeCommand })
          : await runPluginAction(session.id, { ...input, command: actionCommand! });
        if (useAppStore.getState().draftTextBySession[session.id] === inputText) clearDraft(session.id);
        setCommandOutputs((outputs) => ({ ...outputs,
          [session.id]: { command: trimmed, output: response.output || (actionCommand && !response.turnId ? '（空结果）' : '') },
        }));
      } catch (err) {
        pushToast({ kind: 'error', title: actionCommand ? '插件动作执行失败' : '原生命令执行失败', body: err instanceof Error ? err.message : String(err) });
      } finally {
        setSending(false);
        textareaRef.current?.focus();
      }
      return;
    }
    setSending(true);
    const outgoingAtts = [...attachments];
    const outgoingTerminalChips = [...pendingTerminalChips];
    const outgoingText =
      trimmed ||
      (outgoingTerminalChips.length > 0 && outgoingAtts.length === 0
        ? '请结合附带的终端报错上下文进行分析与修复。'
        : '请结合附带的图片/文件进行分析。');
    try {
      const turnAttachments = outgoingAtts.length > 0 ? outgoingAtts : undefined;
      const wantsPreview = !pluginMode && !suggestionChoice && plugins.some((plugin) => plugin.hasRuntimeHook && isPluginEnabled(plugin.id));
      if (wantsPreview) {
        const { suggestion: proposed } = await daemonApi.previewTurnSuggestion(session.id, outgoingText, turnAttachments)
          .catch(() => ({ suggestion: null }));
        const currentDraft = useAppStore.getState();
        if ((currentDraft.draftTextBySession[session.id] ?? '') !== inputText ||
          JSON.stringify((currentDraft.draftAttachmentsBySession[session.id] ?? []).map(({ id }) => id)) !==
            JSON.stringify(outgoingAtts.map(({ id }) => id))) return;
        if (proposed) {
          setSuggestion({ ...proposed, key: suggestionKey });
          return;
        }
      }
      setSuggestion(undefined);
      clearDraft(session.id);
      setFilePickerOpen(false);
      const approved = suggestionChoice === 'apply' && activeSuggestion;
      await sendTurn(session.id, approved ? approved.text : outgoingText, turnAttachments, {
        omitHandoff: handoffOmitted,
        literalText: Boolean(approved),
        mode: pluginMode ? 'plugin_development' : undefined,
        turnOptions:
          Object.keys(effectiveTraitValues).length > 0 ? effectiveTraitValues : undefined,
        terminalContexts: outgoingTerminalChips.length > 0 ? outgoingTerminalChips : undefined,
      });
      setOmitHandoffFor(undefined);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleExport = async () => {
    try {
      const { filename, markdown } = await daemonApi.exportSessionMarkdown(session.id);
      await bridge.call('files.download', { filename, text: markdown, mime: 'text/markdown;charset=utf-8' });
      pushToast({ kind: 'success', title: `已导出 ${filename}` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '导出失败',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleTitleSave = async () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== session.title) {
      await updateSession(session.id, { title: trimmed });
    }
  };

  const activeNativeWorkCount = nativeProjection
    ? nativeProjection.work.filter(
        (w) => w.state.kind === 'known' && (w.state.value === 'running' || w.state.value === 'waiting'),
      ).length
    : 0;
  const nativeContinuationActivities = nativeProjection
    ? nativeProjection.activities.filter(
        (act) =>
          act.origin !== 'user_turn' ||
          act.state === 'waiting_background' ||
          act.state === 'requires_action' ||
          act.state === 'reconciling',
      )
    : [];
  const showFullWorkbench =
    nativeWorkbenchActive &&
    nativeRoute.surface !== 'chat' &&
    !isNarrowViewport &&
    nativeRoute.layout === 'full';
  const showSplitOrSheetWorkbench =
    nativeWorkbenchActive &&
    nativeRoute.surface !== 'chat' &&
    (isNarrowViewport || nativeRoute.layout === 'split');
  const isNarrowSheetOpen = showSplitOrSheetWorkbench && isNarrowViewport;

  const sharedWorkbenchProps = {
    session,
    projection: nativeProjection,
    syncState: nativeSyncState,
    capabilities: nativeCapabilities,
    pendingApprovals: sessionPendingRequests,
    route: nativeRoute,
    returnFocusToRef: workbenchTriggerRef,
    onNavigate: (patch: Parameters<typeof setNativeWorkbenchRoute>[1]) =>
      setNativeWorkbenchRoute(session.id, patch),
    onBackToChat: () => {
      pendingWorkbenchFocusRestoreRef.current = true;
      setNativeWorkbenchRoute(session.id, { surface: 'chat' });
    },
    onRefresh: () => void hydrateNativeRuntime(session.id),
    onResolveRequest: resolveRuntimeRequest,
    onSubmitCommand: async (req: Parameters<typeof submitNativeCommand>[1]) => {
      await submitNativeCommand(session.id, req);
    },
    onDispatchControl: (req: Parameters<typeof dispatchNativeControl>[1]) =>
      dispatchNativeControl(session.id, req),
    loadTimeline: stableLoadNativeTimeline,
    loadWorkflowResource: stableLoadNativeWorkflowResource,
  };

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {showFullWorkbench && embeddedWorkbenchPlugin && embeddedWorkbenchSlot ? (
        <div className="flex h-full min-w-0 flex-1 overflow-hidden">
          <BoundSessionSurface
            plugin={embeddedWorkbenchPlugin}
            surface={embeddedWorkbenchSlot.id}
            session={session}
            props={{ layout: 'full', surface: nativeRoute.surface }}
          />
        </div>
      ) : (
      <div
        aria-hidden={isNarrowSheetOpen || undefined}
        inert={isNarrowSheetOpen ? true : undefined}
        className="atelier-canvas flex h-full min-w-0 flex-1 flex-col"
      >
        {/* Minimalist Session Top Bar */}
        <header
          className="app-drag flex h-[54px] shrink-0 items-center justify-between gap-2 px-4"
          style={{
            borderBottom: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--bg-glass)',
            backdropFilter: 'blur(14px)',
          }}
        >
          <div className="app-no-drag flex min-w-0 items-center gap-2">
            {sidebarCollapsed && (
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                title="展开侧边栏"
                className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                <PanelLeft size={16} />
              </button>
            )}

            <HarnessSwitcher
              session={session}
              harnesses={harnesses}
              disabled={isRunning}
              placement="bottom"
              onSwitch={(targetId) => void switchHarness(session.id, { targetHarnessId: targetId })}
            />

            {editingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void handleTitleSave()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleTitleSave();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                autoFocus
                className="w-[220px] rounded-md px-2 py-0.5 text-[13.5px] font-medium text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-focus)',
                }}
              />
            ) : (
              <Slot
                name="session.header.title"
                slotProps={{
                  session,
                  onRename: () => {
                    setTitleDraft(session.title);
                    setEditingTitle(true);
                  },
                }}
                compactErrors
                fallback={
                  <button
                    type="button"
                    onClick={() => {
                      setTitleDraft(session.title);
                      setEditingTitle(true);
                    }}
                    title="点击重命名会话"
                    className="cursor-pointer truncate text-[13.5px] font-medium tracking-tight text-[var(--text-primary)] hover:underline"
                  >
                    {session.title}
                  </button>
                }
              />
            )}

            {/* Verified Active Model Badge (prevents silent model mismatch!) */}
            {session.actualModel && (
              <span
                title={
                  session.modelReroutedReason
                    ? `模型发生重路由: ${session.modelReroutedReason}`
                    : `CLI 后台已确认实际运行模型: ${session.actualModel}`
                }
                className="hidden items-center gap-1 rounded-full px-2 py-0.5 font-mono-code text-[10.5px] lg:inline-flex"
                style={{
                  backgroundColor: session.modelReroutedReason
                    ? 'var(--accent-star-soft)'
                    : 'var(--accent-emerald-soft)',
                  color: session.modelReroutedReason
                    ? 'var(--accent-star)'
                    : 'var(--accent-emerald)',
                  border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                }}
              >
                {session.modelReroutedReason ? (
                  <AlertTriangle size={10.5} />
                ) : (
                  <CheckCircle2 size={10.5} />
                )}
                <span className="max-w-[160px] truncate">{session.actualModel}</span>
              </span>
            )}

            {session.worktreeBranch && (
              <span
                className="hidden items-center gap-1 rounded-md px-2 py-0.5 font-mono-code text-[10.5px] xl:inline-flex"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                  color: 'var(--text-secondary)',
                }}
              >
                <GitBranch size={11} />
                {session.worktreeBranch}
              </span>
            )}
          </div>

          <div className="app-no-drag flex shrink-0 items-center gap-1.5">
            {nativeWorkbenchActive && (
              <button
                ref={workbenchTriggerRef}
                type="button"
                data-testid="agy-runtime-topbar-trigger"
                aria-expanded={nativeRoute.surface !== 'chat'}
                onClick={() =>
                  setNativeWorkbenchRoute(session.id, {
                    surface: nativeRoute.surface === 'chat' ? 'runtime' : 'chat',
                  })
                }
                title="打开或收起 AGY 原生工作台（切换视图不会停止 AGY）"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
                style={{
                  backgroundColor:
                    nativeRoute.surface !== 'chat' ? 'var(--bg-active)' : 'var(--bg-surface)',
                  color:
                    nativeRoute.surface !== 'chat'
                      ? 'var(--accent-indigo)'
                      : 'var(--text-secondary)',
                  border: `1px solid ${
                    nativeRoute.surface !== 'chat' ? 'var(--border-focus)' : 'var(--border-hairline)'
                  }`,
                }}
              >
                <ActivityIcon size={13} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                <span className="hidden sm:inline">AGY 工作台</span>
                {nativeProjection && (
                  <EntityStatusBadge kind="runtime" status={nativeProjection.status} compact />
                )}
                {activeNativeWorkCount > 0 && (
                  <span className="font-mono-code text-[10px] text-[var(--accent-indigo)]">
                    {activeNativeWorkCount} 运行
                  </span>
                )}
                {sessionPendingRequests.length > 0 && (
                  <span className="rounded-full bg-[var(--accent-star-soft)] px-1.5 py-0.2 font-mono-code text-[10px] font-semibold text-[var(--accent-star)]">
                    {sessionPendingRequests.length}
                  </span>
                )}
              </button>
            )}

            {contextMeter && (
              <button
                type="button"
                onClick={() => openModal('usage')}
                title={
                  `上下文窗口占用 ${contextMeter.usagePercent}% (${formatTokenCount(contextMeter.usedTokens)} / ${formatTokenCount(contextMeter.maxTokens)})${contextMeter.isEstimated ? ' · 估算' : ''}` +
                  (contextMeter.cacheHitRate !== null ? ` · Prompt Cache 命中 ${contextMeter.cacheHitRate}%` : '') +
                  (contextMeter.level === 'critical'
                    ? ' · 建议立即 /compact 或开启新会话'
                    : contextMeter.level === 'warning'
                      ? ' · 上下文接近高位'
                      : '')
                }
                className="hidden cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 font-mono-code text-[10.5px] transition-colors hover:bg-[var(--bg-hover)] xl:flex"
                style={{
                  backgroundColor:
                    contextMeter.level === 'critical'
                      ? 'var(--accent-rose-soft)'
                      : contextMeter.level === 'warning'
                        ? 'var(--accent-star-soft)'
                        : 'var(--bg-surface)',
                  color:
                    contextMeter.level === 'critical'
                      ? 'var(--accent-rose)'
                      : contextMeter.level === 'warning'
                        ? 'var(--accent-star)'
                        : 'var(--text-muted)',
                  border: `1px solid ${
                    contextMeter.level === 'critical'
                      ? 'color-mix(in srgb, var(--accent-rose) 35%, transparent)'
                      : contextMeter.level === 'warning'
                        ? 'color-mix(in srgb, var(--accent-star) 35%, transparent)'
                        : 'var(--border-hairline)'
                  }`,
                }}
              >
                <span>
                  {formatTokenCount(contextMeter.usedTokens)}/{formatTokenCount(contextMeter.maxTokens)} · {contextMeter.usagePercent}%
                </span>
                {contextMeter.cacheHitRate !== null && (
                  <span style={{ color: 'var(--accent-emerald)' }}>
                    Cache {contextMeter.cacheHitRate}%
                  </span>
                )}
                {session.usage?.costUsd !== undefined && session.usage.costUsd > 0 && (
                  <span className="text-[var(--accent-star)]">
                    ${session.usage.costUsd.toFixed(3)}
                  </span>
                )}
              </button>
            )}

            {taskLedgerEnabled && (
              <button
                type="button"
                onClick={() => {
                  setInspectorTab('task');
                  setInspectorOpen(true);
                }}
                title="查看与编辑任务状态账本（已同步至 .harnessmate/task-ledger.md）"
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                style={{ border: '1px solid var(--border-hairline)' }}
              >
                <ListChecks size={13} className="text-[var(--accent-indigo)]" />
                <span className="hidden lg:inline">任务账本</span>
                {taskState && taskState.steps.length > 0 && (
                  <span className="font-mono-code text-[10px] text-[var(--accent-emerald)]">
                    {taskState.steps.filter((s) => s.status === 'done').length}/{taskState.steps.length}
                  </span>
                )}
              </button>
            )}

            {explorerEnabled && (
              <>
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => void forkSession(session.id, {})}
                  title="从此会话当前进度创建分叉子会话（优先原生分叉，不支持则便携降级）"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                  style={{ border: '1px solid var(--border-hairline)' }}
                >
                  <GitFork size={13} />
                  <span className="hidden lg:inline">分叉</span>
                </button>
                {session.parentSessionId && (
                  <button
                    type="button"
                    disabled={isRunning}
                    onClick={() => void mergeBackSession(session.id, {})}
                    title="提炼分叉增量结论 (fork_delta_summary) 并合并回父会话"
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--accent-indigo)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
                    style={{ border: '1px solid var(--border-focus)' }}
                  >
                    <GitMerge size={13} />
                    <span className="hidden lg:inline">合并回父会话</span>
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              onClick={() => openModal('handoff')}
              title="切换执行引擎或分支为独立新会话"
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <ArrowRightLeft size={13} />
              <span className="hidden md:inline">交接</span>
            </button>

            <button
              type="button"
              onClick={() => void handleExport()}
              title="导出会话为 Markdown"
              className="inline-flex cursor-pointer items-center rounded-lg p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <Download size={13.5} />
            </button>

            <button
              type="button"
              onClick={() => setInspectorOpen(!inspectorOpen)}
              title="切换右侧检视抽屉（变更/文件/终端/日志）"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                backgroundColor: inspectorOpen ? 'var(--bg-active)' : 'transparent',
                color: inspectorOpen ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                border: `1px solid ${inspectorOpen ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
              }}
            >
              <PanelRight size={14} />
              <span className="hidden sm:inline">检视</span>
            </button>
          </div>
        </header>

        {/* Global Attention Strip (current + background + child sessions pending approvals/questions/secrets) */}
        {approvalCenterEnabled ? (
          <GlobalAttentionStrip
            pendingRequests={allGlobalPendingRequests}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onJumpToSession={(targetId) => void selectSession(targetId)}
            onOpenRiskRules={() => openModal('risk_rules')}
          />
        ) : (
          otherAwaitingSessions.length > 0 && (
            <div
              className="flex shrink-0 items-center justify-between gap-2 px-4 py-1.5 text-[11.5px]"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                borderBottom: '1px solid color-mix(in srgb, var(--accent-star) 35%, transparent)',
                color: 'var(--accent-star)',
              }}
            >
              <span className="inline-flex items-center gap-1.5 truncate">
                <ShieldAlert size={13} />
                其他后台会话正在等待权限确认：{otherAwaitingSessions.map((s) => s.title).join('、')}
              </span>
              <button
                type="button"
                onClick={() => void selectSession(otherAwaitingSessions[0]!.id)}
                className="shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-medium underline"
              >
                立即前往
              </button>
            </div>
          )
        )}

        {/* Fallback simple approval alert bar ONLY when approval-center plugin is explicitly disabled */}
        {!approvalCenterEnabled && timeline.pendingApprovals.length > 0 && (
          <div className="shrink-0 px-4 pt-3">
            <div className="mx-auto max-w-[760px] space-y-2">
              {timeline.pendingApprovals.map((appr) => (
                <ApprovalCard
                  key={appr.id}
                  session={session}
                  approval={appr}
                  pinned
                  onResolve={(decision) => void resolveApproval(appr.id, decision)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Prominent Undo Revert Banner after a checkpoint revert */}
        <SessionUndoRevertBar sessionId={session.id} />

        {/* Main Conversation Stream + Turn Minimap */}
        <StudioScope session={session}>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            ref={scrollRef}
            style={{ overflowAnchor: 'none' }}
            onScroll={(event) => {
              const el = event.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 72;
              followBottom.current = atBottom;
              rememberTimelinePosition(session.id, el.scrollTop, atBottom);
            }}
            className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-6"
          >
            <div className="mx-auto max-w-[760px] space-y-7">
              {firstVisible > 0 && (
                <button
                  type="button"
                  className="mx-auto block cursor-pointer rounded-lg px-3 py-1.5 text-[12px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                  onClick={() => {
                    previousHistoryHeight.current = scrollRef.current?.scrollHeight ?? null;
                    followBottom.current = false;
                    setVisibleHistory({ sessionId: session.id, count: visibleCount + TIMELINE_PAGE_SIZE });
                  }}
                >
                  加载更早的消息（{firstVisible}）
                </button>
              )}
              {nativeWorkbenchActive && nativeContinuationActivities.length > 0 && (
                <div className="space-y-2" data-testid="native-continuation-strip">
                  {nativeContinuationActivities.map((act) => {
                    const relatedWork = act.workId
                      ? nativeProjection?.work.find((w) => w.id === act.workId) ?? null
                      : null;
                    const actPending = sessionPendingRequests.filter(
                      (req) => nativeProjection?.receipts?.[req.id]?.activityId === act.id,
                    ).length;
                    return (
                      <NativeActivityLink
                        key={act.id}
                        activity={act}
                        relatedWork={relatedWork}
                        pendingCount={actPending}
                        onOpenWorkbench={(target) =>
                          setNativeWorkbenchRoute(session.id, {
                            surface: target.agentId ? 'subagents' : 'runtime',
                            selectedActivityId: target.id,
                            selectedWorkId: target.workId ?? null,
                            selectedAgentId: target.agentId ?? null,
                          })
                        }
                      />
                    );
                  })}
                </div>
              )}

              {timeline.detachedNativeEvents && timeline.detachedNativeEvents.length > 0 && (
                <details
                  data-testid="detached-native-fallback"
                  className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[11.5px] text-[var(--text-secondary)]"
                >
                  <summary className="cursor-pointer font-medium text-[var(--text-primary)]">
                    已隔离的旧版原生占位事件（{timeline.detachedNativeEvents.length} 条 · 点击可只读回看）
                  </summary>
                  <div className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono-code text-[10.5px]">
                    {timeline.detachedNativeEvents.map((ev) => (
                      <div key={ev.seq} className="truncate text-[var(--text-muted)]">
                        #{ev.seq} [{ev.turnId ?? 'null'}] {ev.type}:{' '}
                        {typeof ev.payload.text === 'string'
                          ? ev.payload.text
                          : JSON.stringify(ev.payload).slice(0, 120)}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {timeline.items.length === 0 ? (
                <SessionReadyPlaceholder
                  session={session}
                  onQuickPrompt={(t) => setDraftText(session.id, t)}
                />
              ) : (
                timeline.items.slice(firstVisible).map((item) =>
                  item.kind === 'switch' ? (
                    <HarnessSwitchDivider
                      key={`sw_${item.seq}`}
                      event={item}
                      harnesses={harnesses}
                      onInspect={() => openModal('context_preview')}
                    />
                  ) : (
                    <TurnBlock
                      key={item.turnId}
                      session={session}
                      turn={item}
                      harnesses={harnesses}
                      accountUsage={accountUsage}
                      failoverPolicy={failoverPolicy}
                      fallbackHarnessKind={session.harnessKind}
                      fallbackHarnessId={session.harnessId}
                      allowFailover={!isRunning && item.status === 'failed'}
                      onFailover={onFailover}
                      onPreviewImage={setLightboxImg}
                      onResolveApproval={resolveApproval}
                      onOpenFile={openFile}
                    />
                  ),
                )
              )}
              <div className="h-4" />
            </div>
          </div>

          <StudioMinimap session={session} entries={minimapEntries} activeTurnId={focusedTurn?.turnId} />
        </div>
        </StudioScope>

        {commandOutputs[session.id]?.output && (
          <section role="status" className="mx-5 mb-2 flex min-w-0 items-start gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[12px]">
            <Terminal size={14} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono-code text-[var(--text-muted)]">{commandOutputs[session.id]?.command}</div>
              <div className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[var(--text-primary)]">
                {commandOutputs[session.id]?.output}
              </div>
            </div>
            <button type="button" aria-label="关闭命令输出" className="p-1 text-[var(--text-muted)]"
              onClick={() => setCommandOutputs((outputs) => ({ ...outputs, [session.id]: { command: '', output: '' } }))}>
              <X size={14} />
            </button>
          </section>
        )}

        {/* Floating Glass Composer Dock (Drag-Drop + Paste Image + @file + /slash + ModelPicker) */}
        <div className="shrink-0 px-4 pb-4 pt-1">
          {approvalCenterEnabled && (
            <ComposerPendingRequestBar
              session={session}
              pendingRequests={sessionPendingRequests}
              onResolve={resolveRuntimeRequest}
              onOpenRiskRules={() => openModal('risk_rules')}
            />
          )}
          {pluginMode && (
            <div className="mx-auto mb-2 flex max-w-[760px] items-center justify-between gap-2 px-1 text-[12px] text-[var(--text-secondary)]">
              <span>描述你想定制的功能，当前模型会收到 SDK、安装和热重载说明。</span>
              <button type="button" className="shrink-0 cursor-pointer text-[var(--accent-indigo)] underline" onClick={() => openModal('plugins')}>插件中心</button>
            </div>
          )}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (attachmentsEnabled) setDraggingOver(true);
            }}
            onDragLeave={() => setDraggingOver(false)}
            onDrop={handleDrop}
            className="relative mx-auto max-w-[760px] rounded-2xl p-2.5 transition-all"
            style={{
              backgroundColor: 'var(--bg-glass)',
              backdropFilter: 'blur(18px)',
              border: `1px solid ${draggingOver ? 'var(--accent-indigo)' : 'var(--border-strong)'}`,
              boxShadow: draggingOver
                ? '0 0 0 3px var(--accent-indigo-soft), var(--shadow-float)'
                : 'var(--shadow-float)',
            }}
          >
            {/* Floating Slash Command Autocomplete */}
            {slashMatches.length > 0 && (
              <div
                className="animate-fade-up absolute right-0 bottom-full left-0 z-40 mb-2 overflow-hidden rounded-2xl p-1.5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'var(--shadow-float)',
                }}
              >
                <div className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  对话命令
                </div>
                <div className="max-h-[210px] overflow-y-auto">
                  {slashMatches.map((cmd) => (
                    <button
                      key={`${cmd.pluginId}-${cmd.command}`}
                      type="button"
                      onClick={() => {
                        setDraftText(session.id, `/${cmd.command} `);
                        textareaRef.current?.focus();
                      }}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono-code text-[12.5px] font-semibold text-[var(--accent-indigo)]">
                            /{cmd.command}
                          </span>
                          {cmd.argumentHint && (
                            <span className="font-mono-code text-[11px] text-[var(--text-muted)]">
                              {cmd.argumentHint}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-[11.5px] text-[var(--text-secondary)]">
                          {cmd.description}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]" style={{ backgroundColor: 'var(--bg-elevated)' }}>
                        {cmd.pluginName}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Floating @file Workspace Mention Popover */}
            {filePickerOpen && (
              <div
                className="animate-fade-up absolute right-0 bottom-full left-0 z-40 mb-2 overflow-hidden rounded-2xl p-1.5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'var(--shadow-float)',
                }}
              >
                <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <span>引用工作区文件 (@{filePickerQuery})</span>
                  <button
                    type="button"
                    onClick={() => setFilePickerOpen(false)}
                    className="cursor-pointer hover:text-[var(--text-primary)]"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="max-h-[210px] overflow-y-auto">
                  {filePickerItems.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[11.5px] text-[var(--text-muted)]">
                      无匹配文件
                    </div>
                  ) : (
                    filePickerItems.map((f) => (
                      <button
                        key={f.relativePath}
                        type="button"
                        onClick={() => handleSelectMentionFile(f)}
                        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <FileCode2 size={13} className="shrink-0 text-[var(--accent-indigo)]" />
                          <span className="font-mono-code truncate text-[12px] text-[var(--text-primary)]">
                            {f.relativePath}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono-code text-[10.5px] text-[var(--text-muted)]">
                          {(f.sizeBytes / 1024).toFixed(1)}KB
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {activeSuggestion && <section className="mb-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px]">
              <p className="text-[var(--text-primary)]">插件建议 · {activeSuggestion.pluginNames.join('、')}</p>
              <pre className="my-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-[var(--text-secondary)]">{activeSuggestion.text}</pre>
              <div className="flex justify-end gap-3 text-[var(--accent-indigo)]">
                <button type="button" disabled={sending || isRunning} onClick={() => void handleSend('original')}>发送原文</button>
                <button type="button" disabled={sending || isRunning} onClick={() => void handleSend('apply')}>采用建议并发送</button>
              </div>
            </section>}

            {/* Context Bridge Sync Status Strip (shown when active harness has un-synced delta turns) */}
            {contextBridgeEnabled && contextPreview && contextPreview.syncNeeded && (
              <div
                className="mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-[11px]"
                style={{
                  backgroundColor: 'var(--accent-indigo-soft)',
                  border: '1px solid color-mix(in srgb, var(--accent-indigo) 32%, transparent)',
                  color: 'var(--text-primary)',
                }}
              >
                <div className="flex min-w-0 items-center gap-1.5 truncate">
                  <Sparkles size={12} className="shrink-0 text-[var(--accent-indigo)]" />
                  <span className="truncate">
                    {handoffOmitted ? '本轮已移除上下文交接' : <>下条消息将通过{' '}
                    <strong className="font-medium text-[var(--accent-indigo)]">
                      {DRIVER_LABELS[contextPreview.driverPlanned] ?? contextPreview.driverPlanned}
                    </strong>{' '}
                    同步{' '}
                    {contextPreview.unsyncedTurnCount > 0
                      ? `${contextPreview.unsyncedTurnCount} 轮增量对话 + 任务账本`
                      : '任务账本'}{' '}
                    <span className="font-mono-code opacity-80">
                      (~{formatTokenCount(contextPreview.estimatedTokens)} tok)
                    </span>
                    </>}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => openModal('context_preview')}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-indigo)] transition-colors hover:bg-[var(--bg-surface)]"
                >
                  <Eye size={11} />
                  预览上下文
                </button>
                <button type="button" className="shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-[var(--accent-indigo)] hover:bg-[var(--bg-surface)]"
                  onClick={() => setOmitHandoffFor(handoffOmitted ? undefined : `${session.id}:${session.harnessId}`)}>
                  {handoffOmitted ? '恢复交接' : '本轮移除'}
                </button>
              </div>
            )}

            {/* Pending Terminal Context Chips */}
            <ComposerPendingTerminalContexts
              chips={pendingTerminalChips}
              onRemove={(chipId) => removePendingTerminalChip(session.id, chipId)}
            />

            {/* Attachment Preview Strip */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 px-2 pt-1">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="group relative flex items-center gap-2 rounded-xl px-2 py-1.5 text-[11.5px]"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    {att.kind === 'image' && att.previewUrl ? (
                      <AttachmentImage
                        path={att.previewUrl}
                        alt={att.name}
                        className="h-9 w-9 cursor-pointer rounded-lg object-cover"
                        onPreview={setLightboxImg}
                      />
                    ) : (
                      <FileText size={14} className="shrink-0 text-[var(--accent-indigo)]" />
                    )}
                    <span className="max-w-[160px] truncate font-mono-code text-[11px] text-[var(--text-primary)]">
                      {att.relativePath || att.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeDraftAttachment(session.id, att.id)}
                      className="cursor-pointer rounded-full p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-rose)]"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.py,.kt,.java,.go,.rs,.yaml,.yml,.toml,.css,.html,.sql,.log,.csv"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleUploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            {nativeWorkbenchActive && (nativeCommandSubmission || (isRunning && !canSteerActive)) && (
              <div
                role="status"
                data-testid="agy-native-composer-status"
                className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-[11px]"
                style={{
                  backgroundColor:
                    nativeCommandSubmission?.phase === 'conflict' || nativeCommandSubmission?.phase === 'failed'
                      ? 'var(--accent-rose-soft)'
                      : 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                  color:
                    nativeCommandSubmission?.phase === 'conflict' || nativeCommandSubmission?.phase === 'failed'
                      ? 'var(--accent-rose)'
                      : 'var(--text-secondary)',
                }}
              >
                <span>
                  {nativeCommandSubmission?.message ??
                    '当前轮次运行中，草稿已保留；可查看正在进行的工作，等待原生完成后再发送。'}
                </span>
                <button
                  type="button"
                  onClick={() => setNativeWorkbenchRoute(session.id, { surface: 'runtime' })}
                  className="shrink-0 cursor-pointer font-medium text-[var(--accent-indigo)] underline"
                >
                  查看正在进行的工作
                </button>
              </div>
            )}

            <textarea
              ref={textareaRef}
              data-session-composer
              rows={1}
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend();
                } else if (e.key === 'Escape') {
                  setFilePickerOpen(false);
                }
              }}
              placeholder={
                draggingOver
                  ? '松开鼠标即可附带图片或文件...'
                  : isRunning
                    ? nativeWorkbenchActive && !canSteerActive
                      ? '运行期间可继续编辑草稿，或在工作台查看正在进行的工作...'
                      : 'Agent 正在执行本轮任务，可随时点击右侧停止...'
                    : pluginMode
                      ? '描述你要开发的插件功能…'
                      : nativeWorkbenchActive && activeNativeMode && activeNativeMode.id !== 'normal'
                        ? activeNativeMode.placeholder
                        : `向 ${harness?.displayName ?? session.harnessId} 发送指令 · / 对话命令 · @ 引用文件 · Ctrl+V 贴图`
              }
              className="max-h-[180px] w-full resize-none bg-transparent px-2.5 py-1.5 text-[13.8px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />

            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1 pt-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {attachmentsEnabled && (
                  <>
                    <button
                      type="button"
                      disabled={uploading || isRunning}
                      onClick={() => fileInputRef.current?.click()}
                      title="上传图片或文件（也支持拖拽与 Ctrl+V 粘贴截图）"
                      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      {uploading ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <ImagePlus size={12.5} />
                      )}
                      <span className="hidden sm:inline">附件</span>
                    </button>

                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => {
                        setFilePickerOpen(!filePickerOpen);
                        setFilePickerQuery('');
                      }}
                      title="引用工作区文件 (@file)"
                      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                      style={{
                        backgroundColor: filePickerOpen ? 'var(--bg-active)' : 'var(--bg-elevated)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      <AtSign size={12.5} />
                    </button>
                  </>
                )}

                {!pluginMode && (nativeCommands.length > 0 || slashCommands.length > 0 || panelCommands.length > 0 || pluginActions.length > 0) && (
                  <button
                    type="button"
                    disabled={isRunning}
                    onClick={() => {
                      setDraftText(session.id, '/');
                      textareaRef.current?.focus();
                    }}
                    title="插件斜杠指令 (/)"
                    className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <Slash size={12} />
                  </button>
                )}

                {modelTools && modelTools.count > 0 && <span role="status" className="text-[11px] text-[var(--text-secondary)]" title={
                  modelTools.status === 'connected' ? '当前 CLI 已查询插件工具列表'
                    : modelTools.status === 'next_turn' ? '下次发送消息时更新会话工具'
                    : modelTools.status === 'unsupported' ? '当前 CLI 会话未接受插件工具连接'
                    : '已配置会话连接，等待 CLI 查询工具列表'}>
                  {modelTools.count} 个模型工具{modelTools.status === 'unsupported' ? '不可用' : modelTools.status === 'next_turn' ? '待接入' : ''}
                </span>}

                <Slot
                  name="composer.actions"
                  slotProps={{ session, isRunning }}
                  compactErrors
                />

                <button type="button" aria-pressed={pluginMode} disabled={isRunning || sending}
                  onClick={() => setPluginModeSessions((current) => {
                    const next = new Set(current);
                    if (next.has(session.id)) next.delete(session.id);
                    else next.add(session.id);
                    return next;
                  })}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] disabled:opacity-50 ${pluginMode
                    ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo-soft)] text-[var(--accent-indigo)]'
                    : 'border-[var(--border-hairline)] text-[var(--text-secondary)]'}`}>
                  <Wrench size={12} /> 插件开发
                </button>

                {/* Inline Unified Harness Switcher */}
                <HarnessSwitcher
                  session={session}
                  harnesses={harnesses}
                  disabled={isRunning}
                  placement="top"
                  onSwitch={(targetId) => void switchHarness(session.id, { targetHarnessId: targetId })}
                />

                {/* Searchable Grouped Real Model Picker */}
                {harness && harness.models.length > 0 && (
                  <ModelPicker
                    models={harness.models}
                    sessionId={session.id}
                    harnessInstanceId={session.harnessId}
                    value={session.model}
                    defaultModelId={harness.defaultModelId}
                    disabled={isRunning}
                    placement="top"
                    onChange={(nextModel) => {
                      const nextMeta = harness.models.find((m) => m.id === nextModel);
                      const effortStillValid =
                        !session.reasoningEffort ||
                        !nextMeta?.supportedEfforts ||
                        nextMeta.supportedEfforts.includes(session.reasoningEffort);
                      void updateSession(session.id, {
                        model: nextModel,
                        ...(effortStillValid ? {} : { reasoningEffort: nextMeta?.defaultEffort ?? null }),
                      });
                    }}
                  />
                )}

                {/* V5 Schema-Driven Dynamic TraitsPicker (composer.traits slot) */}
                <Slot
                  name="composer.traits"
                  slotProps={{
                    session,
                    harness,
                    disabled: isRunning,
                    values: effectiveTraitValues,
                    onChange: handleTraitChange,
                  }}
                  compactErrors
                  fallback={
                    <TraitsPicker
                      descriptors={activeOptionDescriptors}
                      values={effectiveTraitValues}
                      disabled={isRunning}
                      onChange={handleTraitChange}
                    />
                  }
                />

                {/* Permission Mode Selector */}
                <select
                  value={session.permissionMode}
                  aria-label="权限模式"
                  disabled={isRunning}
                  onChange={(e) =>
                    void updateSession(session.id, {
                      permissionMode: e.target.value as PermissionMode,
                    })
                  }
                  className="cursor-pointer rounded-lg px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus:outline-none disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  {[...permissionModes].map(
                    (mode) => (
                      <option key={mode} value={mode}>
                        模式: {PERMISSION_MODE_LABELS[mode]?.label ?? mode}
                      </option>
                    ),
                  )}
                </select>
              </div>

              <div className="flex items-center gap-2">
                {isRunning && (
                  <button
                    type="button"
                    onClick={() => void interruptSession(session.id)}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[12px] font-medium text-white transition-all hover:opacity-90"
                    style={{ backgroundColor: 'var(--accent-rose)' }}
                  >
                    <Square size={11} fill="currentColor" />
                    <span>停止</span>
                  </button>
                )}
                {(!isRunning || isGoalControl || canSteerActive) && (
                  <button
                    type="button"
                    title={canSteerActive ? '发送运行中引导指令 (Mid-turn Steering)' : '发送'}
                    disabled={(!inputText.trim() && attachments.length === 0 && pendingTerminalChips.length === 0) || sending}
                    onClick={() => void handleSend()}
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl text-white transition-all disabled:cursor-not-allowed disabled:opacity-35"
                    style={{ backgroundColor: canSteerActive ? 'var(--accent-emerald)' : 'var(--accent-indigo)' }}
                  >
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {showSplitOrSheetWorkbench && embeddedWorkbenchPlugin && embeddedWorkbenchSlot && (
        <div
          className={
            isNarrowViewport
              ? 'h-full w-full'
              : 'h-full w-[440px] max-w-[48vw] shrink-0 overflow-hidden'
          }
        >
          <BoundSessionSurface
            plugin={embeddedWorkbenchPlugin}
            surface={embeddedWorkbenchSlot.id}
            session={session}
            props={{ layout: 'split', surface: nativeRoute.surface }}
          />
        </div>
      )}



      {/* Image Lightbox */}
      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ backgroundColor: 'rgba(4, 6, 12, 0.85)', backdropFilter: 'blur(8px)' }}
          onClick={() => setLightboxImg(null)}
        >
          <img
            src={lightboxImg}
            alt="Preview"
            className="max-h-[88vh] max-w-[90vw] rounded-2xl object-contain"
            style={{ boxShadow: 'var(--shadow-float)' }}
          />
        </div>
      )}
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function HarnessSwitchDivider({
  event,
  harnesses,
  onInspect,
}: {
  event: ProjectedSwitchEvent;
  harnesses: readonly HarnessInfo[];
  onInspect: () => void;
}) {
  const fromMeta = resolveHarnessMeta(
    { harnessId: event.fromHarnessId, harnessKind: event.fromHarnessKind },
    harnesses,
  );
  const toMeta = resolveHarnessMeta(
    { harnessId: event.toHarnessId, harnessKind: event.toHarnessKind },
    harnesses,
  );

  return (
    <div className="animate-fade-up flex items-center gap-3 py-1">
      <div className="h-px flex-1" style={{ backgroundColor: 'var(--border-hairline)' }} />
      <button
        type="button"
        onClick={onInspect}
        title="点击预览当前会话上下文同步详情"
        className="inline-flex max-w-full cursor-pointer flex-wrap items-center justify-center gap-1.5 rounded-full px-3 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <Sparkles size={11} className="shrink-0 text-[var(--accent-star)]" />
        <span style={{ color: fromMeta.accentColor }} className="font-medium">
          {fromMeta.shortLabel}
        </span>
        <span className="opacity-50">→</span>
        <span style={{ color: toMeta.accentColor }} className="font-medium">
          {toMeta.shortLabel}
        </span>
        {event.toModel && (
          <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
            ({event.toModel})
          </span>
        )}
        <span className="opacity-40">·</span>
        <span className="text-[10.5px] text-[var(--text-muted)]">
          {event.isWarmBinding ? '增量同步' : '上下文同步'} {event.unsyncedTurnCount} 轮
          {event.estimatedTokens > 0 ? ` (~${formatTokenCount(event.estimatedTokens)} tok)` : ''}
        </span>
        {event.gitAnchor && (
          <>
            <span className="hidden opacity-40 sm:inline">·</span>
            <span className="hidden font-mono-code text-[10px] text-[var(--text-muted)] sm:inline">
              {event.gitAnchor}
            </span>
          </>
        )}
      </button>
      <div className="h-px flex-1" style={{ backgroundColor: 'var(--border-hairline)' }} />
    </div>
  );
}

const TurnBlock = memo(function TurnBlock({
  session,
  turn,
  harnesses,
  accountUsage,
  failoverPolicy,
  fallbackHarnessKind,
  fallbackHarnessId,
  allowFailover,
  onFailover,
  onPreviewImage,
  onResolveApproval,
  onOpenFile,
}: {
  session: Session;
  turn: ProjectedTurn;
  harnesses: readonly HarnessInfo[];
  accountUsage: readonly HarnessAccountUsage[];
  failoverPolicy: FailoverPolicy | null;
  fallbackHarnessKind: Session['harnessKind'];
  fallbackHarnessId: string;
  allowFailover: boolean;
  onFailover: (targetHarnessId: string) => void;
  onPreviewImage: (src: string) => void;
  onResolveApproval: (id: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onOpenFile: (file: FileLink) => void;
}) {
  const effectiveKind = turn.harnessKind ?? fallbackHarnessKind;
  const effectiveId = turn.harnessId ?? fallbackHarnessId;
  const meta = resolveHarnessMeta(
    { harnessId: effectiveId, harnessKind: effectiveKind },
    harnesses,
  );
  const turnModelLabel = turn.actualModel || turn.model;
  const groupedSegments = useMemo(
    () => (turn.blocks.length > 0 ? groupTurnBlocks(turn.blocks, turn.status === 'running') : []),
    [turn.blocks, turn.status],
  );

  return (
    <SlotTurnProvider turn={turn}>
    <div id={`chat-turn-${turn.turnId}`} tabIndex={-1} className="animate-fade-up space-y-4 rounded-xl focus-visible:outline">
      {/* User Prompt + Attachments */}
      {(turn.userText || turn.userAttachments.length > 0) && (
        <div className="flex flex-col items-end gap-2">
          {turn.userAttachments.length > 0 && (
            <div className="flex max-w-[82%] flex-wrap justify-end gap-2">
              {turn.userAttachments.map((att) =>
                att.kind === 'image' && att.previewUrl ? (
                  <AttachmentImage
                    key={att.id}
                    path={att.previewUrl}
                    alt={att.name}
                    onPreview={onPreviewImage}
                    className="h-24 max-w-[180px] cursor-pointer rounded-xl object-cover transition-transform hover:scale-[1.02]"
                    style={{ border: '1px solid var(--border-strong)' }}
                  />
                ) : (
                  <span
                    key={att.id}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono-code text-[11px] text-[var(--text-secondary)]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <Paperclip size={11} className="text-[var(--accent-indigo)]" />
                    {att.relativePath || att.name}
                  </span>
                ),
              )}
            </div>
          )}

          {turn.userText && (
            <div
              className="max-w-[82%] rounded-2xl rounded-tr-md px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-[var(--text-primary)]"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
              }}
            >
              {turn.expandedCommand && (
                <span
                  className="mr-2 inline-flex items-center rounded-md px-1.5 py-0.5 font-mono-code text-[11px]"
                  style={{
                    backgroundColor: 'var(--accent-indigo-soft)',
                    color: 'var(--accent-indigo)',
                  }}
                >
                  {turn.expandedCommand}
                </span>
              )}
              {turn.userText}
            </div>
          )}
        </div>
      )}

      {turn.handoffSnapshots?.map(({ seq, driver, content, sourceHarnesses, accepted }) => (
        <details key={seq} className="rounded-lg border border-[var(--border-hairline)] px-3 py-2 text-[11.5px]">
          <summary className="cursor-pointer text-[var(--text-secondary)]">
            上下文交接{sourceHarnesses.length > 0 && ` · 来自 ${sourceHarnesses.join('、')}`} · {DRIVER_LABELS[driver] ?? driver}
            {!accepted && ' · 待确认'}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{content}</pre>
        </details>
      ))}

      {/* Assistant Execution & Response Column (Per-Turn Harness & Confirmed Model Attribution) */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.accentColor }} />
          <span className="font-medium text-[var(--text-secondary)]">
            {meta.shortLabel || effectiveId}
          </span>
          {turnModelLabel && (
            <span
              className="rounded-md px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {turnModelLabel}
            </span>
          )}
          {turn.status === 'running' && (
            <span className="inline-flex items-center gap-1 text-[var(--accent-indigo)]">
              <Loader2 size={11.5} className="animate-spin" />
              执行中
            </span>
          )}
          {turn.status === 'cancelled' && (
            <span className="text-[var(--accent-star)]">已中止</span>
          )}
        </div>

        {groupedSegments.length > 0 ? (
          <div className="space-y-2.5">
            {groupedSegments.map((segment) => {
              if (segment.kind === 'work_group') {
                return <StudioWorkGroup key={segment.groupId} session={session} group={segment} />;
              }
              const block = segment.block;
              if (block.type === 'assistant_text') {
                return (
                  <div key={block.blockId} data-item-id={block.blockId} className="pl-0.5">
                    <Slot
                      name="chat.message.wrapper"
                      slotProps={{ session, turn, children: null }}
                    >
                      {block.streaming || turn.status === 'running' ? (
                        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                          {block.text}
                        </div>
                      ) : (
                        <MarkdownView content={block.text} onOpenFile={onOpenFile} />
                      )}
                    </Slot>
                  </div>
                );
              }
              if (block.type === 'html_render') {
                return (
                  <Slot
                    key={block.blockId}
                    name="chat.block"
                    matchKey="html_render"
                    slotProps={{ session, turn, block, onOpenFile, onFailover }}
                    fallback={
                      <HtmlRenderCard
                        renderId={block.renderId ?? block.blockId}
                        title={block.title}
                        html={block.html}
                        preferredHeightPx={block.preferredHeightPx}
                        allowFullscreen={block.allowFullscreen}
                      />
                    }
                  />
                );
              }
              if (block.type === 'runtime_request') {
                return (
                  <Slot
                    key={block.blockId}
                    name="chat.block"
                    matchKey="runtime_request"
                    slotProps={{ session, turn, block, onOpenFile, onFailover }}
                    fallback={
                      <RuntimeRequestReceiptBlock
                        kind={block.kind}
                        title={block.title}
                        receiptText={block.receiptText}
                        requestStatus={block.requestStatus}
                        resolvedBy={block.resolvedBy}
                      />
                    }
                  />
                );
              }
              if (block.type === 'checkpoint_marker') {
                return (
                  <Slot
                    key={block.blockId}
                    name="chat.block"
                    matchKey="checkpoint_marker"
                    slotProps={{ session, turn, block, onOpenFile, onFailover }}
                    fallback={
                      <div
                        className="rounded-xl px-3 py-1.5 text-[11px] text-[var(--text-muted)]"
                        style={{
                          backgroundColor: 'var(--bg-surface)',
                          border: '1px solid var(--border-hairline)',
                        }}
                      >
                        检查点 · Turn #{block.turnSeq} (+{block.insertions} -{block.deletions} ·{' '}
                        {block.filesChanged} 个文件)
                      </div>
                    }
                  />
                );
              }
              if (block.type === 'system_notice') {
                return (
                  <div
                    key={block.blockId}
                    className="rounded-xl px-3 py-2 text-[12px]"
                    style={{
                      backgroundColor:
                        block.level === 'error'
                          ? 'var(--accent-rose-soft)'
                          : block.level === 'warn'
                            ? 'var(--accent-star-soft)'
                            : 'var(--bg-surface)',
                      border: '1px solid var(--border-hairline)',
                      color:
                        block.level === 'error'
                          ? 'var(--accent-rose)'
                          : block.level === 'warn'
                            ? 'var(--accent-star)'
                            : 'var(--text-secondary)',
                    }}
                  >
                    {block.message}
                  </div>
                );
              }
              if (isExtensionOrUnknownBlock(block)) {
                const matchKey = block.type === 'unknown_block' ? block.originalType : block.type;
                return (
                  <Slot
                    key={block.blockId}
                    name="chat.block"
                    matchKey={matchKey}
                    slotProps={{ session, turn, block, onOpenFile, onFailover }}
                    fallback={<StudioExtension session={session} block={block} />}
                  />
                );
              }
              return (
                <Slot
                  key={block.blockId}
                  name="chat.block"
                  matchKey={block.type}
                  slotProps={{ session, turn, block, onOpenFile, onFailover }}
                />
              );
            })}
          </div>
        ) : (
          <>
            {turn.thinking && (
              <ThinkingAccordion
                text={turn.thinking}
                running={turn.status === 'running' && !turn.thinkingDone}
              />
            )}

            {turn.tools.length > 0 && (
              <div className="space-y-2">
                {turn.tools.map((tool) => (
                  <ToolCallCard key={tool.toolCallId} session={session} tool={tool} />
                ))}
              </div>
            )}

            {turn.assistantText && (
              <div className="pl-0.5">
                <Slot
                  name="chat.message.wrapper"
                  slotProps={{ session, turn, children: null }}
                >
                  {turn.status === 'running' ? (
                    <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{turn.assistantText}</div>
                  ) : <MarkdownView content={turn.assistantText} onOpenFile={onOpenFile} />}
                </Slot>
              </div>
            )}
          </>
        )}

        {turn.approvals
          .filter((a) => a.status === 'approved' || a.status === 'denied')
          .map((appr) => (
            <ApprovalCard
              key={appr.id}
              session={session}
              approval={appr}
              onResolve={(decision) => onResolveApproval(appr.id, decision)}
            />
          ))}

        <Slot
          name="chat.node"
          matchKey={`turn.${turn.status}`}
          slotProps={{
            session,
            turn,
            eventType: `turn.${turn.status}`,
          }}
        />

        {turn.status === 'failed' && turn.errorMessage && (
          <FailoverInlineBanner
            sessionId={session.id}
            failedInstanceId={effectiveId}
            failureClass={turn.failureClass}
            errorMessage={turn.errorMessage}
            resetsAt={turn.resetsAt}
            harnesses={allowFailover ? harnesses : []}
            accountUsage={accountUsage}
            failoverPolicy={failoverPolicy}
            onFailover={onFailover}
          />
        )}
      </div>
    </div>
    </SlotTurnProvider>
  );
});

function ThinkingAccordion({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="overflow-hidden rounded-xl"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
      >
        <span className="inline-flex items-center gap-2">
          <Brain size={13.5} className="text-[var(--accent-indigo)]" />
          <span>{running ? '深度思考中...' : '查看思考轨迹'}</span>
        </span>
        {open ? <ChevronDown size={13.5} /> : <ChevronRight size={13.5} />}
      </button>
      {open && (
        <div
          className="max-h-[260px] overflow-y-auto px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ session, tool }: { session: Session; tool: ProjectedToolCall }) {
  const [expanded, setExpanded] = useState(tool.status === 'error');

  const Icon =
    tool.toolKind === 'shell'
      ? Terminal
      : tool.toolKind === 'file_edit' || tool.toolKind === 'file_read'
        ? FileCode2
        : tool.toolKind === 'search'
          ? Search
          : tool.toolKind === 'web'
            ? Globe
            : Wrench;

  const hasDetails = Boolean(tool.output || tool.diff || tool.input);

  return (
    <div
      className="overflow-hidden rounded-xl transition-all"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center justify-between gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-default"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon size={13.5} className="shrink-0 text-[var(--text-secondary)]" />
          <span className="font-mono-code truncate text-[12px] text-[var(--text-primary)]">
            {tool.summary}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {tool.status === 'running' && (
            <Loader2 size={13} className="animate-spin text-[var(--accent-indigo)]" />
          )}
          {tool.status === 'success' && (
            <CheckCircle2 size={13} className="text-[var(--accent-emerald)]" />
          )}
          {tool.status === 'error' && <XCircle size={13} className="text-[var(--accent-rose)]" />}
          {hasDetails && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        </div>
      </button>

      {expanded && hasDetails && (
        <div
          className="space-y-2 p-3 font-mono-code text-[11.5px]"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--code-bg)',
          }}
        >
          <Slot
            name="tool.result"
            matchKey={tool.toolName}
            slotProps={{ session, tool }}
            fallback={
              <>
                {tool.diff && (
                  <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap text-[var(--accent-emerald)]">
                    {tool.diff}
                  </pre>
                )}
                {tool.output && (
                  <pre className="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap text-[var(--text-secondary)]">
                    {tool.output}
                  </pre>
                )}
                {!tool.output && !tool.diff && tool.input != null && (
                  <pre className="m-0 max-h-[180px] overflow-auto whitespace-pre-wrap text-[var(--text-muted)]">
                    {JSON.stringify(tool.input, null, 2)}
                  </pre>
                )}
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  session,
  approval,
  pinned = false,
  onResolve,
}: {
  session: Session;
  approval: ApprovalRequest;
  pinned?: boolean;
  onResolve: (decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const isPending = approval.status === 'pending';

  return (
    <div
      className="animate-fade-up overflow-hidden rounded-2xl p-3.5"
      style={{
        backgroundColor: isPending ? 'var(--bg-glass)' : 'var(--bg-surface)',
        backdropFilter: pinned ? 'blur(16px)' : undefined,
        border: `1px solid ${
          isPending
            ? 'color-mix(in srgb, var(--accent-star) 55%, transparent)'
            : 'var(--border-hairline)'
        }`,
        boxShadow: pinned ? 'var(--shadow-float)' : 'none',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {isPending ? (
            <ShieldAlert size={17} className="mt-0.5 shrink-0 text-[var(--accent-star)]" />
          ) : (
            <ShieldCheck
              size={16}
              className="mt-0.5 shrink-0"
              style={{
                color:
                  approval.status === 'approved' ? 'var(--accent-emerald)' : 'var(--accent-rose)',
              }}
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {isPending ? '需要权限确认' : approval.status === 'approved' ? '已批准操作' : '已拒绝操作'}
              </span>
              <span
                className="rounded-md px-1.5 py-0.5 font-mono-code text-[10.5px]"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                }}
              >
                {approval.toolName}
              </span>
              {approval.resolvedBy && (
                <span className="text-[11px] text-[var(--text-muted)]">
                  · 由{approval.resolvedBy === 'mobile' ? '手机端' : '桌面端'}裁决
                </span>
              )}
            </div>
            <p className="mt-1 font-mono-code text-[12px] break-all text-[var(--text-secondary)]">
              {approval.summary}
            </p>
            <Slot name="approval.detail" slotProps={{ session, approval }} />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          {showRaw ? '收起参数' : '查看详情'}
        </button>
      </div>

      {showRaw && (
        <pre
          className="mt-2.5 max-h-[180px] overflow-auto rounded-xl p-2.5 font-mono-code text-[11px] text-[var(--text-secondary)]"
          style={{
            backgroundColor: 'var(--code-bg)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          {approval.diffPreview || JSON.stringify(approval.input, null, 2)}
        </pre>
      )}

      {isPending && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve('deny')}
            className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--accent-rose-soft)]"
            style={{
              color: 'var(--accent-rose)',
              border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
            }}
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => onResolve('allow_session')}
            className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
            }}
          >
            本会话信任
          </button>
          <button
            type="button"
            onClick={() => onResolve('allow_once')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-medium text-white transition-all hover:opacity-90"
            style={{ backgroundColor: 'var(--accent-emerald)' }}
          >
            <Check size={13} />
            <span>允许本次</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SessionReadyPlaceholder({
  session,
  onQuickPrompt,
}: {
  session: Session;
  onQuickPrompt: (prompt: string) => void;
}) {
  const suggestions = [
    '/review 检查当前工作区最近的代码改动',
    '/explain 分析当前工作区的核心架构与入口模块',
    '/test 运行自动化测试并定位潜在问题',
  ];

  return (
    <div className="py-10 text-center">
      <div className="mx-auto mb-3.5 inline-flex">
        <StarLoomCrest size={42} />
      </div>
      <h2 className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
        {session.title}
      </h2>
      <p className="mx-auto mt-1.5 max-w-[540px] break-all font-mono-code text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        {session.cwd}
      </p>

      <div
        className="mx-auto mt-6 grid max-w-[620px] gap-2.5"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))' }}
      >
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onQuickPrompt(s)}
            className="cursor-pointer rounded-xl p-3.5 text-left text-[12.4px] leading-relaxed text-[var(--text-secondary)] transition-all hover:-translate-y-0.5 hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
              boxShadow: 'var(--shadow-card)',
            }}
          >
            <Sparkles size={13} className="mb-2 text-[var(--accent-star)]" />
            <div>{s}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function AtelierWelcome({
  sidebarCollapsed,
  onExpandSidebar,
  harnesses,
  hasWorkspaces,
  onStartHarness,
  onAddWorkspace,
  onOpenPlugins,
  onOpenUsage,
  onOpenPairing,
}: {
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  harnesses: import('@harnessmate/protocol').HarnessInfo[];
  hasWorkspaces: boolean;
  onStartHarness: (harnessId: string) => void;
  onAddWorkspace: () => void;
  onOpenPlugins: () => void;
  onOpenUsage: () => void;
  onOpenPairing: () => void;
}) {
  return (
    <div className="atelier-canvas relative flex h-full flex-1 flex-col overflow-y-auto">
      {sidebarCollapsed && (
        <div className="p-4">
          <button
            type="button"
            onClick={onExpandSidebar}
            className="cursor-pointer rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <PanelLeft size={16} />
          </button>
        </div>
      )}

      <div className="m-auto w-full max-w-[780px] px-6 py-12">
        <div className="text-center">
          <div className="mx-auto mb-5 inline-flex">
            <StarLoomCrest size={52} />
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-[var(--text-primary)]">
            模块化微内核，编织全部 Agent Harness
          </h1>
          <p className="mx-auto mt-2.5 max-w-[540px] text-[13.8px] leading-relaxed text-[var(--text-secondary)]">
            实时同步全部已注册 CLI 与插件 Harness 的真实模型、动态参数、多账号限额与 MCP；
            所有能力均以插件方式按需装卸，并原生联动移动端 HarnessMate。
          </p>
        </div>

        {/* Live Probed Harness Launch Cards */}
        <div className="mt-9 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
          {harnesses.slice(0, 6).map((h) => {
            const meta = resolveHarnessMeta({ harness: h }, harnesses);
            const ready = h.health === 'ready';
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => onStartHarness(h.id)}
                className="group flex cursor-pointer flex-col justify-between rounded-2xl p-4 text-left transition-all hover:-translate-y-0.5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <HarnessBadge kind={h.kind} label={h.displayName} presentation={h.presentation} />
                    <span
                      className="font-mono-code text-[11px] font-medium"
                      style={{
                        color: ready ? 'var(--accent-emerald)' : 'var(--text-muted)',
                      }}
                    >
                      {ready ? `v${h.version ?? 'ok'}` : '未检测到'}
                    </span>
                  </div>
                  <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                    {h.accountSummary || h.protocolLabel}
                  </p>
                </div>

                <div
                  className="mt-4 flex items-center justify-between pt-3 text-[11.5px]"
                  style={{ borderTop: '1px solid var(--border-hairline)' }}
                >
                  <span className="text-[var(--text-muted)]">
                    {h.models.length > 0 ? `${h.models.length} 个实时模型` : '默认配置'}
                  </span>
                  <span
                    className="font-medium transition-transform group-hover:translate-x-0.5"
                    style={{ color: meta.accentColor }}
                  >
                    启动会话 →
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Quick Studio Actions */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          {!hasWorkspaces && (
            <button
              type="button"
              onClick={onAddWorkspace}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-4 py-2 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)',
              }}
            >
              <FolderGit2 size={14} className="text-[var(--accent-indigo)]" />
              <span>添加本地工作区</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenPlugins}
            className="cursor-pointer rounded-xl px-3.5 py-2 text-[12.2px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            打开插件中心（按需安装功能）
          </button>
          <button
            type="button"
            onClick={onOpenUsage}
            className="cursor-pointer rounded-xl px-3.5 py-2 text-[12.2px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            查看多账号限额与用量
          </button>
          <button
            type="button"
            onClick={onOpenPairing}
            className="cursor-pointer rounded-xl px-3.5 py-2 text-[12.2px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            手机扫码远程联动
          </button>
        </div>
      </div>
    </div>
  );
}
