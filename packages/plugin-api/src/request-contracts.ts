import type { ServiceMethodResult } from './context.js';

export const RUNTIME_REQUESTS_CONTRACT = 'runtime.requests.v1';
export const REQUEST_VIEW_CONTRACT = 'runtime.requests.view.v1';
export const REQUEST_DELIVERY_CONTRACT = 'runtime.request-delivery.v1';
export type RequestMode = 'manual' | 'accept_edits' | 'auto' | 'plan';
export type RequestDelivery = 'not_required' | 'pending' | 'sending' | 'acknowledged' | 'unknown' | 'unavailable';
export interface RequestOriginDto {
  providerInstanceId: string;
  driverGeneration: string;
  connectionId?: string;
  runtimeId?: string;
  nativeRequestId: string | number;
  turnId: string | null;
}
export interface RuntimeRequestDto {
  requestId: string;
  sessionId: string;
  workspaceId: string;
  origin: RequestOriginDto;
  version: number;
  idempotencyKey: string;
  deadlineAtMs: number;
  status: string;
  delivery: RequestDelivery;
  closed: boolean;
  presentation?: Record<string, unknown>;
  /** Legacy ApprovalRequest fields; secret plaintext is forbidden here. */
  approval: Record<string, unknown>;
  policyInstanceId?: string;
  policyRevision?: string;
  /** Exact driver option/scope. Legacy approval.decision cannot express persistent/unknown native scope. */
  decisionReceipt?: { actor: RequestResolveDto['actor']; decision?: RequestResolveDto['decision']; nativeOutcome?: string; optionId?: string; scope?: 'once' | 'session' | 'persistent' | 'unknown' };
  execution?: { state: 'succeeded' | 'failed'; finishedAtMs: number };
}
export interface RequestCreateDto {
  approval: Record<string, unknown>;
  presentation?: Record<string, unknown>;
  workspaceId: string;
  origin: RequestOriginDto;
  deadlineAtMs: number;
  idempotencyKey: string;
  /** Revocable, serializable origin resource. No function or credential crosses the service boundary. */
  deliveryResource?: { instanceId: string; runId: string; resourceId: string };
}
export interface RequestDeliveryServiceV1 {
  validate(input: { resourceId: string; response: RequestResolveDto }): Promise<ServiceMethodResult<{ valid: boolean }>>;
  deliver(input: { resourceId: string; response: RequestResolveDto }): Promise<ServiceMethodResult<{ delivery: RequestDelivery }>>;
  release?(input: { resourceId: string }): Promise<ServiceMethodResult<{ released: boolean }>>;
}
export interface RequestResolveDto {
  requestId: string;
  expectedVersion?: number;
  idempotencyKey?: string;
  actor: 'desktop' | 'mobile' | 'auto';
  decision?: 'allow_once' | 'allow_session' | 'deny';
  comment?: string;
  questionAnswer?: { selectedOptionIds?: string[]; freeText?: string };
  /** Transient transport only: never persisted, published or echoed. */
  secretValue?: string;
  native?: Record<string, unknown>;
}
export interface RequestPolicyInputDto {
  requestId?: string;
  sessionId: string;
  workspaceId: string;
  mode: RequestMode;
  kind: string;
  toolName: string;
  toolKind: string;
  readOnly: boolean;
  riskLevel?: string;
  supportedDecisions: string[];
  source: 'cli' | 'native' | 'model_tool';
  args?: Record<string, unknown>;
}
export interface RequestPolicyDecisionDto {
  decision: 'allow' | 'deny' | 'ask';
  scope?: 'once' | 'session';
  reason?: string;
}
/** evaluateToolCall remains compatible with v1 consumers. */
export interface ApprovalPolicyServiceV1 {
  evaluateToolCall(input: Record<string, unknown>): Promise<RequestPolicyDecisionDto> | RequestPolicyDecisionDto;
  evaluateRequest?(input: RequestPolicyInputDto): Promise<RequestPolicyDecisionDto> | RequestPolicyDecisionDto;
}
export interface RequestModeReceiptDto {
  sessionId: string;
  requested: RequestMode;
  policyInstanceId: string | null;
  policyRevision: string | null;
  status: 'applied' | 'pending_next_session' | 'unsupported' | 'rejected' | 'policy_handled';
  driverRequested?: Record<string, unknown>;
  driverAccepted?: Record<string, unknown>;
  execution: 'driver' | 'per_request_policy' | 'none';
  note?: string;
}
export interface RuntimeRequestsServiceV1 {
  create(input: RequestCreateDto): Promise<ServiceMethodResult<RuntimeRequestDto>>;
  snapshot(input: { sessionId?: string; includeHistory?: boolean }): Promise<ServiceMethodResult<{ requests: RuntimeRequestDto[]; version: number }>>;
  resolve(input: RequestResolveDto): Promise<ServiceMethodResult<{ accepted: boolean; conflict: boolean; request: RuntimeRequestDto }>>;
  cancel(input: { sessionId?: string; reason: string }): Promise<ServiceMethodResult<{ cancelled: number }>>;
  close(input: { requestId: string }): Promise<ServiceMethodResult<{ closed: boolean }>>;
  evaluate(input: RequestPolicyInputDto): Promise<ServiceMethodResult<RequestPolicyDecisionDto & { policyInstanceId: string; policyRevision: string }>>;
  recordMode(input: RequestModeReceiptDto): Promise<ServiceMethodResult<RequestModeReceiptDto>>;
  /** Optional configuration UI of the default request provider; not a policy restriction. */
  listRules?(): Promise<ServiceMethodResult<{ rules: unknown[] }>>;
  addRule?(input: Record<string, unknown>): Promise<ServiceMethodResult<{ rules: unknown[] }>>;
  deleteRule?(input: { id: string }): Promise<ServiceMethodResult<{ rules: unknown[] }>>;
  getMode(input: { sessionId: string }): Promise<ServiceMethodResult<RequestModeReceiptDto | null>>;
}
