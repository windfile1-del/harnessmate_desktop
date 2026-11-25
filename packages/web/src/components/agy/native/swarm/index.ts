export {
  SWARM_OFFICIAL_DOC_URL,
  SWARM_OFFICIAL_CLI_BOARD_HINT,
  SWARM_OFFICIAL_CLI_LAUNCH_HINT,
  extractAgentEvidence,
  resolveSwarmAgentDisplayName,
  findSwarmCapability,
  resolveSafeSwarmControlCapability,
  resolveSwarmBoardStatus,
  parseBoardResourcePosts,
  groupBoardPostsIntoThreads,
  parseSwarmLogEntries,
  filterEntriesBySource,
  buildSwarmStudioViewModel,
  type SwarmStudioTab,
  type SwarmWorkflowEntity,
  type SwarmWorkerViewRow,
  type SwarmWorkerSummaryCounts,
  type SwarmBoardPostDto,
  type SwarmBoardThreadGroup,
  type SwarmLogEntryDto,
  type SwarmBoardStatusSummary,
  type SwarmControlGuardResult,
  type SwarmStudioViewModel,
} from './swarm-view-model';

export { SwarmBoardPanel, type SwarmBoardPanelProps } from './SwarmBoardPanel';
export { SwarmWorkersPanel, type SwarmWorkersPanelProps } from './SwarmWorkersPanel';
export { SwarmActivityPanel, type SwarmActivityPanelProps } from './SwarmActivityPanel';
export { SwarmStudioView, type SwarmStudioViewProps } from './SwarmStudioView';
export { registerSwarmStudioView } from './register';
export {
  createSwarmCapabilitiesFixture,
  createStructuredSwarmProjectionFixture,
  createUpstreamLimitedSwarmProjectionFixture,
} from './fixtures';
