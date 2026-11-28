import type { TriageSnoozeExpired } from '@harnessmate/protocol';
import { showSessionNotification } from '../../lib/desktop-notifications';
import type {
  AddMcpServerRequest,
  AgyAuthState,
  Attachment,
  AttentionItem,
  CanonicalEvent,
  CheckpointRevertResult,
  ContextPreview,
  ContextSyncMode,
  CreateSessionRequest,
  CustomAcpHarnessConfig,
  DelegateSubagentRequest,
  DiscoveredCliSession,
  FailoverPolicy,
  FailoverRequest,
  ForkSessionRequest,
  ForkSessionResult,
  GitDryRunMergeResult,
  GitStatusSummary,
  HarnessAccountUsage,
  HarnessCommandResult,
  HarnessInfo,
  HarnessKind,
  InstalledPluginInfo,
  ImportNativeSessionRequest,
  ImportSessionBundleRequest,
  InstallPluginRequest,
  ManagedTerminalTab,
  McpServerEntry,
  MergeBackRequest,
  MergeBackResult,
  MergeSubagentRequest,
  MarkSessionViewedRequest,
  OpenTerminalRequest,
  OrchestratorBoardResponse,
  PluginCatalogItem,
  PluginMcpPreset,
  PluginSlashCommand,
  RemoteAccessStatus,
  RevertCheckpointRequest,
  RunHarnessCommandRequest,
  RunPluginActionRequest,
  Session,
  SessionCheckpointRecord,
  SessionTaskState,
  SessionTriageState,
  SubagentDiffStat,
  SubagentMergeBackResult,
  SubagentRunRecord,
  SwitchHarnessRequest,
  TerminalContextChip,
  ToggleMcpServerRequest,
  TurnBlockRecord,
  TurnOptionValue,
  TurnOptionsMap,
  UpdateSessionRequest,
  UpdateTaskStateRequest,
  UpdateSessionTriageRequest,
  Workspace,
} from '@harnessmate/protocol';
import { create } from 'zustand';
import { ApiHttpError, DaemonWsClient, daemonApi, type HarnessServiceScope } from '../../api/client';
import {
  HISTORY_IMPORT_CONTRACT,
  HISTORY_IMPORT_PAGE_SLOT_ID,
  SESSION_SEARCH_CONTRACT,
  SESSION_SEARCH_PAGE_SLOT_ID,
  WORKSPACE_FILES_CONTRACT,
  getPluginInstanceId,
  isContractAvailableClientSide,
  isPluginInstanceReady,
  makeWorkspacePageKey,
  pluginProvidesContract,
  resolveServiceSelectionClientSide,
  type NavigateToFileRequest,
  type NavigateToFileResult,
  type ServiceResolutionV1,
} from '../../api/peer-contracts';
import { defaultPeerWorkspaceTransport } from '../../api/peer-workspace-client';
import { parseFileLink } from '../../lib/file-links';
import {
  DEFAULT_WORKBENCH_ROUTE,
  type WorkbenchRouteState,
} from '../../components/agy/native/shared/workbench-registry';
import { loadSavedTraitValues, persistTraitValues } from '../../components/TraitsPicker';
import {
  NativeClientError,
  NativeFeedController,
  applyNativeEventBatch,
  createNativeIdempotencyKey,
  defaultNativeTransport,
  type ActivityId,
  type CapabilityDescriptor,
  type NativeAgentId,
  type NativeCanonicalEvent,
  type NativeCommandSubmitRequest,
  type NativeControlRequest,
  type NativeFeedSyncState,
  type NativeRuntimeProjection,
  type NativeRuntimeTransport,
  type NativeTimelinePageResponse,
  type NativeWorkflowResourcePageResponse,
  type RuntimeBinding,
  type WorkflowId,
} from '../../lib/native-client';
import { isTriageEnabled, mergeTriageState, type TriageStateBySession } from '../../lib/triage';


import type { AppState, ToastNotice } from '../../stores/app-store';
import { callPeer, getActiveBridge, startView, triggerLoadEarlierHistory, type ChatPluginState, type PageBridge } from './transport';

export const useAppStore = create<ChatPluginState>((set, get) => {
 const actions: Partial<AppState> = {
refreshOrchestratorBoard: async (sessionId) => {
  const board = await daemonApi.listSubagents(sessionId);
  set(state => ({ orchestratorBoardBySession: { ...state.orchestratorBoardBySession, [sessionId]: board } }));
},
delegateSubagent: async (sessionId, request) => {
  try {
    const { subagent } = await daemonApi.delegateSubagent(sessionId, request);
    await get().refreshOrchestratorBoard(sessionId);
    return subagent;
  } catch (error) { get().pushToast({ kind: 'error', title: '派生子任务失败', body: String(error) }); return null; }
},
stopSubagent: async (subagentId, sessionId, reason) => {
  await daemonApi.stopSubagent(subagentId, reason);
  await get().refreshOrchestratorBoard(sessionId);
},
cleanupSubagentWorktree: async (subagentId, sessionId, options) => {
  await daemonApi.cleanupSubagentWorktree(subagentId, options);
  await get().refreshOrchestratorBoard(sessionId);
},
initSessionGit: async sessionId => {
  const result = await daemonApi.initSessionGit(sessionId);
  set(state => ({ gitBySession: { ...state.gitBySession, [sessionId]: result.git } }));
},
focusTurn: (focusedTurn) => set({ focusedTurn }),
setDraftText: (sessionId, text) =>
      set((s) => ({ draftTextBySession: { ...s.draftTextBySession, [sessionId]: text } })),
addDraftAttachment: (sessionId, att) =>
      set((s) => {
        const curr = s.draftAttachmentsBySession[sessionId] ?? [];
        if (curr.some((x) => x.id === att.id || (att.relativePath && x.relativePath === att.relativePath))) {
          return s;
        }
        return {
          draftAttachmentsBySession: {
            ...s.draftAttachmentsBySession,
            [sessionId]: [...curr, att],
          },
        };
      }),
removeDraftAttachment: (sessionId, attId) =>
      set((s) => ({
        draftAttachmentsBySession: {
          ...s.draftAttachmentsBySession,
          [sessionId]: (s.draftAttachmentsBySession[sessionId] ?? []).filter((a) => a.id !== attId),
        },
      })),
clearDraft: (sessionId) =>
      set((s) => ({
        draftTextBySession: { ...s.draftTextBySession, [sessionId]: '' },
        draftAttachmentsBySession: { ...s.draftAttachmentsBySession, [sessionId]: [] },
        pendingTerminalChipsBySession: { ...s.pendingTerminalChipsBySession, [sessionId]: [] },
      })),
addPendingTerminalChip: (sessionId, chip) =>
      set((state) => {
        const curr = state.pendingTerminalChipsBySession[sessionId] ?? [];
        if (curr.some((item) => item.id === chip.id)) return state;
        return {
          pendingTerminalChipsBySession: {
            ...state.pendingTerminalChipsBySession,
            [sessionId]: [...curr.slice(-11), chip],
          },
        };
      }),
removePendingTerminalChip: (sessionId, chipId) =>
      set((state) => ({
        pendingTerminalChipsBySession: {
          ...state.pendingTerminalChipsBySession,
          [sessionId]: (state.pendingTerminalChipsBySession[sessionId] ?? []).filter(
            (item) => item.id !== chipId,
          ),
        },
      })),
clearPendingTerminalChips: (sessionId) =>
      set((state) => ({
        pendingTerminalChipsBySession: {
          ...state.pendingTerminalChipsBySession,
          [sessionId]: [],
        },
      })),
isPluginEnabled: (pluginId) => {
      const found = get().plugins.find((p) => p.id === pluginId);
      return found ? found.enabled && (!found.runtimeState || found.runtimeState === 'ACTIVE') : true;
    },
refreshTurnItems: async (sessionId) => {
      try {
        const { items } = await daemonApi.getSessionTurnItems(sessionId, { limit: 1000 });
        set((state) => ({
          turnItemsBySession: { ...state.turnItemsBySession, [sessionId]: items },
        }));
      } catch {
        // ignore if endpoint unavailable
      }
    },
setTraitValue: (scopeKey, key, value) => {
      set((state) => {
        const existing = state.traitsByScope[scopeKey] ?? loadSavedTraitValues(scopeKey);
        const next = { ...existing };
        if (value === null || value === undefined || value === '') {
          delete next[key];
        } else {
          next[key] = value;
        }
        persistTraitValues(scopeKey, next);
        return {
          traitsByScope: { ...state.traitsByScope, [scopeKey]: next },
        };
      });
    },
runHarnessCommand: async (id, req) => {
      const result = await daemonApi.runHarnessCommand(id, req);
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === id && session.lastSeq <= result.session.lastSeq
          ? result.session : session),
      }));
      return result;
    },
runPluginAction: async (id, req) => {
      const result = await daemonApi.runPluginAction(id, req);
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === id && session.lastSeq <= result.session.lastSeq
          ? result.session : session),
      }));
      return result;
    },
updateSession: async (id, patch) => {
      const { session } = await daemonApi.updateSession(id, patch);
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? session : s)),
      }));
    },
refreshContextPreview: async (sessionId, targetHarnessId, syncMode) => {
      try {
        const { preview } = await daemonApi.getContextPreview(sessionId, targetHarnessId, syncMode);
        set((state) => ({
          contextPreviewBySession: {
            ...state.contextPreviewBySession,
            [sessionId]: preview,
          },
        }));
        return preview;
      } catch {
        return null;
      }
    },
refreshTaskState: async (sessionId) => {
      try {
        const { taskState } = await daemonApi.getTaskState(sessionId);
        set((state) => ({
          taskStateBySession: { ...state.taskStateBySession, [sessionId]: taskState },
        }));
      } catch {
        // ignore
      }
    },
updateTaskState: async (sessionId, patch) => {
      try {
        const { taskState } = await daemonApi.updateTaskState(sessionId, patch);
        set((state) => ({
          taskStateBySession: { ...state.taskStateBySession, [sessionId]: taskState },
        }));
        void get().refreshContextPreview(sessionId);
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '更新任务账本失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },
summarizeTaskState: async (sessionId) => {
      try {
        const { taskState } = await daemonApi.summarizeTaskState(sessionId);
        set((state) => ({
          taskStateBySession: { ...state.taskStateBySession, [sessionId]: taskState },
        }));
        void get().refreshContextPreview(sessionId);
        get().pushToast({
          kind: 'success',
          title: '已提炼历史对话摘要并同步至 .harnessmate/task-ledger.md',
        });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '提炼摘要失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },
interruptSession: async (sessionId) => {
      await daemonApi.interruptSession(sessionId);
      get().pushToast({ kind: 'info', title: '已发送中断信号' });
    },
forkSession: async (sessionId, req) => {
      try {
        const res = await daemonApi.forkSession(sessionId, req ?? {});
        set((state) => ({
          sessions: [res.session, ...state.sessions.filter((s) => s.id !== res.session.id)],
        }));
        await get().selectSession(res.session.id);
        get().pushToast({
          kind: 'success',
          title: res.modeUsed === 'native' ? '已创建原生分叉子会话' : '已创建便携分叉子会话',
          body: res.notice,
        });
        return res;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '创建分叉失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
mergeBackSession: async (sessionId, req) => {
      try {
        const res = await daemonApi.mergeBackSession(sessionId, req ?? {});
        await get().selectSession(res.parentSessionId);
        void get().refreshTurnItems(res.parentSessionId);
        get().pushToast({
          kind: 'success',
          title: '已将分叉结论合并回父会话',
          body: `已注入 fork_delta_summary（seq #${res.eventSeq}）`,
        });
        return res;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '合并回父会话失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
refreshCheckpoints: async (sessionId) => {
      try {
        const res = await daemonApi.listCheckpoints(sessionId);
        set((state) => ({
          checkpointsBySession: {
            ...state.checkpointsBySession,
            [sessionId]: res.checkpoints,
          },
          supportsNativeRollbackBySession: {
            ...state.supportsNativeRollbackBySession,
            [sessionId]: res.supportsNativeRollback,
          },
        }));
      } catch {
        // ignore if checkpoints service disabled
      }
    },
revertCheckpoint: async (sessionId, req) => {
      try {
        const res = await daemonApi.revertCheckpoint(sessionId, req);
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? res.session : s)),
          checkpointsBySession: {
            ...state.checkpointsBySession,
            [sessionId]: res.checkpoints,
          },
          lastRevertBySession: {
            ...state.lastRevertBySession,
            [sessionId]: res.result,
          },
        }));
        void get().refreshGitStatus(sessionId);
        void get().refreshTurnItems(sessionId);
        get().pushToast({
          kind: 'success',
          title: `已回滚至 Turn #${res.result.targetTurnSeq}`,
          body: `还原 ${res.result.filesRestored} 个文件，清理 ${res.result.untrackedRemoved} 个新增文件。可随时点击顶部横幅“撤销回滚”。`,
        });
        return res.result;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '回滚检查点失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
clearLastRevert: (sessionId) =>
      set((state) => ({
        lastRevertBySession: { ...state.lastRevertBySession, [sessionId]: null },
      }))
 };
 const shellNames = ['setSidebarCollapsed','setInspectorOpen','setInspectorTab','openModal','openPluginPanel','selectSession','openSessionSearch','openSessionSearchPage','openHistoryImportPage','setNativeWorkbenchRoute','hydrateNativeRuntime','submitNativeCommand','dispatchNativeControl','loadNativeTimeline','loadNativeWorkflowResource','setNativeAgentMode','refreshAll','focusCheckpointDiff','openSubagentMergeReview'];
 const shell = Object.fromEntries(shellNames.map(name=>[name,(...args: unknown[])=>getActiveBridge().call('shell.invoke',{name,args})]));
 return {
theme: 'dark',
connected: false,
loading: true,
sidebarCollapsed: false,
inspectorOpen: false,
inspectorTab: 'task',
activeModal: null,
paletteInitialQuery: '',
explorerInitialQuery: '',
newSessionPresetHarnessId: null,
harnesses: [],
workspaces: [],
sessions: [],
triageBySession: {},
discoveredSessions: [],
remoteStatus: null,
plugins: [],
emptyComposition: false,
sessionBindingsBySession: {},
workspaceBindingsByWorkspace: {},
compositionBindings: {},
compositionEntries: [],
serviceResolutionsByKey: {},
pluginPermissionRevision: 0,
selectedPluginPanel: null,
focusedTurn: null,
pluginCatalog: [],
slashCommands: [],
mcpPresets: [],
pluginsDir: '',
searchPageInitialQuery: '',
searchPageTargetInstanceId: null,
importPageTargetInstanceId: null,
importPageInitialTab: 'native',
mcpServers: [],
mcpLoading: false,
accountUsage: [],
usageLoading: false,
usageCollectedAt: null,
failoverPolicy: null,
selectedWorkspaceId: null,
harnessFilter: null,
searchQuery: '',
selectedSessionId: null,
activePluginPage: null,
eventsBySession: {},
eventChunksBySession: {},
turnItemsBySession: {},
liveCommandOutputByKey: {},
traitsByScope: {},
gitBySession: {},
checkpointsBySession: {},
supportsNativeRollbackBySession: {},
lastRevertBySession: {},
orchestratorBoardBySession: {},
mergeBackReviewTarget: null,
focusedCheckpointDiff: null,
taskStateBySession: {},
contextPreviewBySession: {},
draftTextBySession: {},
draftAttachmentsBySession: {},
pendingTerminalChipsBySession: {},
terminalsByWorkspace: {},
terminalPtyAvailable: false,
terminalOutputById: {},
agyAuthStates: {},
agyNativeWorkbenchEnabled: false,
nativeRuntimeBySession: {},
toasts: [],
inspectorFile: null,
inspectorFileError: null,
historyMetaBySession: {},
loadEarlierHistory: (sessionId: string) => triggerLoadEarlierHistory(sessionId),
 ...shell, ...actions,
 openInspectorFile: (sessionId: string,path: string,line?: number)=>{ void getActiveBridge().navigateToFile({sessionId,path,line}); return {opened:true}; },
 navigateToFile: (request: NavigateToFileRequest)=>{ void getActiveBridge().navigateToFile(request); return {opened:true}; },
 pushToast: (notice: Omit<ToastNotice,'id'>)=>{ void getActiveBridge().call('ui.toast',notice); },
 sendTurn: async (sessionId,text,attachments,options)=>{
   const requestId=crypto.randomUUID();
   const receipt=await callPeer('session.runtime.v1','sendTurn',[{sessionId,text,attachments,requestId,...options}],{sessionId});
   if(!receipt.ok)throw new Error(receipt.error.message);
 },
 failoverSession: async (sessionId,req)=>{await daemonApi.failoverSession(sessionId,req);},
 switchHarness: async (sessionId,req)=>{
   const result = await daemonApi.switchHarness(sessionId,req);
   set(state=>({sessions:state.sessions.map(session=>session.id===sessionId?result.session:session),
     contextPreviewBySession:{...state.contextPreviewBySession,[sessionId]:result.contextPreview}}));
 },
 refreshGitStatus: async (sessionId)=>{
   const {git}=await daemonApi.getSessionGit(sessionId);
   set(state=>({gitBySession:{...state.gitBySession,[sessionId]:git}}));
 },
 subscribeCommandOutput: (sessionId,toolCallId)=>{let released=false; void getActiveBridge().call('outputs.subscribe',{sessionId,toolCallId}).then(()=>{if(released)void getActiveBridge().call('outputs.unsubscribe',{sessionId,toolCallId});}).catch(()=>{}); return ()=>{released=true;void getActiveBridge().call('outputs.unsubscribe',{sessionId,toolCallId});};},
 } as ChatPluginState;
});

export const startChatView = (bridgeOverride?: PageBridge) => startView(useAppStore, bridgeOverride);
