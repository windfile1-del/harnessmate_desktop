import assert from 'node:assert/strict';
import { BoostWorkflowObserver, createT11BoostSyntheticFixtures } from '../dist/harnesses/agy/native/workflows/boost/index.js';
import { DynamicWorkflowObserver } from '../dist/harnesses/agy/native/workflows/dynamic/index.js';
import { AgyTeamworkWorkflowObserver, createT12RejectedScenario } from '../dist/harnesses/agy/native/workflows/teamwork/index.js';

const pack = createT11BoostSyntheticFixtures();
const boost = new BoostWorkflowObserver();
boost.registerBinding(pack);
boost.recordConfirmedLaunch(pack);
const unrelatedConfigFailure = boost.acceptFrame({
  ...pack.frames.serverDenied,
  wire: { jsonrpc: '2.0', id: 48761, error: { code: -32602, message: 'Invalid reasoning effort value' } },
});
const wrongBoostState = boost.getWorkflowState(pack.binding, pack.workflowId)?.workflow.state;
assert.equal(unrelatedConfigFailure.accepted, true);
assert.ok(wrongBoostState?.kind === 'known' && wrongBoostState.value === 'failed');
console.log('G3-02 reproduced: unrelated RPC error id=48761 failed the active Boost workflow');

const dynamic = new DynamicWorkflowObserver();
dynamic.registerRootSession(pack.binding, pack.rootNativeSessionId);
function dynamicFrame(status, ingressOrdinal, channel = 'live') {
  return {
    binding: pack.binding,
    connectionId: pack.connectionId,
    originSession: pack.rootNativeSessionId,
    ingressOrdinal,
    channel,
    wire: {
      method: 'session/update',
      params: {
        sessionId: pack.rootNativeSessionId,
        update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'tool_dyn_probe',
          workflowId: 'dyn_probe', workflowKind: 'dynamic', status,
        },
      },
    },
  };
}
const first = dynamic.acceptFrame(dynamicFrame('in_progress', 1));
assert.equal(first.accepted, true);
const workflowId = first.workflowIds[0];
dynamic.handleTransportClosed(pack.binding, pack.connectionId);
assert.equal(dynamic.getObservedWorkflowSnapshot(pack.binding, workflowId)?.workflow.state.kind, 'stale');
const late = dynamic.acceptFrame(dynamicFrame('completed', 2));
const revived = dynamic.getObservedWorkflowSnapshot(pack.binding, workflowId)?.workflow.state;
assert.equal(late.accepted, true);
assert.ok(revived?.kind === 'known' && revived.value === 'finished');
const oldTarget = dynamic.resolveRequestTarget({
  binding: pack.binding, connectionId: 'unrelated-connection',
  actualNativeSessionId: 'unrelated-session', wireRequestId: 19, workflowIdHint: 'dyn_probe', rawParams: {},
});
assert.equal(oldTarget?.scope, 'confirmed_workflow');
console.log('G3-04 reproduced: late retired frame settles a stale workflow; unrelated session/connection resolves a confirmed request');

const replayed = new DynamicWorkflowObserver();
const done = replayed.acceptFrame(dynamicFrame('completed', 1));
assert.equal(done.accepted, true);
const id = done.workflowIds[0];
const rewind = replayed.acceptFrame(dynamicFrame('in_progress', 2, 'history_replay'));
const rewindState = replayed.getObservedWorkflowSnapshot(pack.binding, id)?.workflow.state;
assert.equal(rewind.accepted, true);
assert.ok(rewindState?.kind === 'known' && rewindState.value === 'running');
console.log('G3-05 reproduced: historical progress rewinds live finished workflow to running');

const scenario = createT12RejectedScenario();
const advertisement = scenario.steps[0]?.envelope;
assert.ok(advertisement);
const teamwork = new AgyTeamworkWorkflowObserver({ featureGates: { teamworkEnabled: true, reviewControlEnabled: false } });
const initialAttempt = teamwork.recordLaunchAttempt({ binding: scenario.binding, rawCommand: '/teamwork sketch a draft' });
assert.equal(initialAttempt.accepted, true);
const historical = teamwork.acceptIngressFrame({ ...advertisement, channel: 'history_replay' });
assert.equal(historical.accepted, true);
assert.equal(teamwork.getPublicProjection(scenario.binding)?.commandDiscovery, 'advertised');
console.log('G3-03 reproduced: unknown catalog permits Teamwork launch preparation; history replay becomes advertised');


const { AgySwarmObserver, createSyntheticSwarmBinding, createT10FullStructuredSwarmFrames } = await import('../dist/harnesses/agy/native/workflows/swarm/index.js');
const swarmBinding = createSyntheticSwarmBinding();
const t10 = createT10FullStructuredSwarmFrames({ binding: swarmBinding });
const swarm = new AgySwarmObserver({ gates: { swarmEnabled: true, boardFeedEnabled: true } });
const swarmConnection = t10.frames[0].connectionId;
swarm.registerBinding({ binding: swarmBinding, connectionId: swarmConnection, rootNativeSessionId: t10.rootNativeSessionId, profileRef: 'profile_dedicated_test', sourceRef: 'acp' });
swarm.acceptFrame(t10.frames[0]);
swarm.handleTransportClosed(swarmBinding, swarmConnection);
assert.equal(swarm.getStateSnapshot(swarmBinding)?.workflows[0]?.workflow.state.kind, 'stale');
const swarmLate = swarm.acceptFrame(t10.frames.at(-1));
const swarmRevived = swarm.getStateSnapshot(swarmBinding)?.workflows[0]?.workflow.state;
assert.equal(swarmLate.accepted, true);
assert.ok(swarmRevived?.kind === 'known' && swarmRevived.value === 'finished');
console.log('G3-04 reproduced for Swarm: retiring the connection disables its ID check and the old tail settles the workflow');

const staleBoost = new BoostWorkflowObserver();
staleBoost.registerBinding(pack);
staleBoost.recordConfirmedLaunch(pack);
staleBoost.handleTransportClosed(pack.binding, pack.connectionId);
assert.equal(staleBoost.getWorkflowState(pack.binding, pack.workflowId)?.workflow.state.kind, 'stale');
const staleBoostFrame = staleBoost.acceptFrame(pack.frames.nativeCancelConfirmed);
const newBoostState = staleBoost.getWorkflowState(pack.binding, pack.workflowId)?.workflow.state;
assert.equal(staleBoostFrame.accepted, true);
assert.ok(newBoostState?.kind === 'known' && newBoostState.value === 'cancelled');
console.log('G3-04 reproduced for Boost: a retired connection frame rewrites stale to cancelled');

const staleTeamwork = new AgyTeamworkWorkflowObserver({ featureGates: { teamworkEnabled: true, reviewControlEnabled: false } });
staleTeamwork.acceptIngressFrame(advertisement);
staleTeamwork.handleTransportClosed(scenario.binding, advertisement.connectionId);
const oldCatalog = staleTeamwork.acceptIngressFrame({ ...advertisement, ingressOrdinal: 999 });
assert.equal(oldCatalog.accepted, true);
const currentConnection = staleTeamwork.acceptIngressFrame({ ...advertisement, ingressOrdinal: 1, connectionId: 'replacement-connection' });
assert.equal(currentConnection.reasonCode, 'stale_generation_or_connection');
console.log('G3-04 reproduced for Teamwork: a retired frame reclaims the active connection slot');

const replayedSwarm = new AgySwarmObserver({ gates: { swarmEnabled: true, boardFeedEnabled: true } });
replayedSwarm.registerBinding({ binding: swarmBinding, connectionId: swarmConnection, rootNativeSessionId: t10.rootNativeSessionId, profileRef: 'profile_dedicated_test', sourceRef: 'acp' });
replayedSwarm.acceptFrame(t10.frames.at(-1));
const lateHistory = replayedSwarm.acceptFrame({ ...t10.frames[0], channel: 'history_replay' });
const replayedSwarmState = replayedSwarm.getStateSnapshot(swarmBinding)?.workflows[0]?.workflow.state;
assert.equal(lateHistory.accepted, true);
assert.ok(replayedSwarmState?.kind === 'known' && replayedSwarmState.value === 'running');
console.log('G3-05 reproduced for Swarm: replay rewinds a terminal live workflow');
