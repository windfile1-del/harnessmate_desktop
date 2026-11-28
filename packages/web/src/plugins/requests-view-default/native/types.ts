import type {
  ApprovalAnnotationDto,
  ApprovalRequest,
  ResolveNativeRequestInput,
  RiskLevel,
} from '@harnessmate/protocol';
import type {
  Activity,
  ActivityId,
  AgentIdentity,
  AgentLineage,
  NativeAgentId,
  NativeRequestReceiptDto,
  NativeRequestReceiptState,
  NativeWorkflow,
  WorkflowId,
  WorkflowKind,
} from '../../../lib/native-client';

export type NativeRequestOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | 'decline'
  | 'custom';

export interface NativeRequestOptionView {
  readonly optionId: string;
  readonly name: string;
  readonly kind?: NativeRequestOptionKind;
  readonly description?: string;
  readonly securityWarning?: string;
  readonly scopeWidening?: boolean;
}

export type NativeElicitationFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'string_array';

export type NativeElicitationStringFormat = 'email' | 'uri' | 'date' | 'date-time';

export interface NativeElicitationFieldView {
  readonly name: string;
  readonly type: NativeElicitationFieldType;
  readonly title?: string;
  readonly description?: string;
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly enumNames?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: NativeElicitationStringFormat;
  readonly defaultValue?: string | number | boolean | readonly string[];
}

export interface NativeElicitationFormSpecView {
  readonly message: string;
  readonly mode: 'form' | 'url';
  readonly fields: readonly NativeElicitationFieldView[];
  readonly requiredFields: readonly string[];
  readonly additionalProperties: boolean;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export type NativeRequestScopeView =
  | 'root'
  | 'confirmed_child'
  | 'confirmed_workflow'
  | 'unknown_child';

/**
 * Optional sanitized display metadata hydrated from NP-07 detail DTOs or fixtures.
 * Never holds private connectionId, wireRequestId, actualNativeSessionId, or host paths.
 */
export interface NativeRequestDisplayMeta {
  readonly scope?: NativeRequestScopeView;
  readonly targetLineage?: AgentLineage;
  readonly agentLabel?: string;
  readonly workflowId?: WorkflowId;
  readonly workflowKind?: WorkflowKind;
  readonly workflowLabel?: string;
  readonly isDetached?: boolean;
  readonly forwardedToParentSession?: boolean;
  readonly provenanceReason?: string;
  readonly occurrence?: number;
  readonly toolName?: string;
  readonly summary?: string;
  readonly diffPreview?: string | null;
  readonly riskLevel?: RiskLevel;
  readonly annotations?: readonly ApprovalAnnotationDto[];
  readonly securityWarnings?: readonly string[];
  readonly options?: readonly NativeRequestOptionView[];
  readonly questionText?: string;
  readonly formSpec?: NativeElicitationFormSpecView;
  readonly canAnswer?: boolean;
  readonly canCancel?: boolean;
  readonly unsupportedReason?: string;
  readonly resolvedAt?: number;
  readonly terminalReason?: string;
}

export interface NativeRequestViewItem {
  readonly approvalId: string;
  readonly receipt: NativeRequestReceiptDto;
  readonly approval: ApprovalRequest | null;
  readonly ownerAgent: AgentIdentity | null;
  readonly activity: Activity | null;
  readonly workflow: NativeWorkflow | null;
  readonly meta: NativeRequestDisplayMeta | null;
  readonly scope: NativeRequestScopeView;
  readonly targetLineage: AgentLineage;
  readonly isGenerationCurrent: boolean;
  readonly isRuntimeAttached: boolean;
  readonly isPending: boolean;
  readonly isActionable: boolean;
  readonly canAnswer: boolean;
  readonly canCancel: boolean;
  readonly isDetached: boolean;
  readonly forwardedToParentSession: boolean;
  readonly options: readonly NativeRequestOptionView[];
  readonly allowedOptionIds: readonly string[];
  readonly securityWarnings: readonly string[];
  readonly annotations: readonly ApprovalAnnotationDto[];
  readonly riskLevel: RiskLevel;
  readonly unsupportedReason?: string;
}

export interface NativeRequestResolveOutcomeView {
  readonly receiptId?: string;
  readonly receiptState?: NativeRequestReceiptState;
  readonly conflict?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type ResolveNativeRequestHandler = (
  approvalId: string,
  input: ResolveNativeRequestInput,
) => Promise<NativeRequestResolveOutcomeView>;

export interface NativeRequestNavigationHandlers {
  readonly onJumpToAgent?: (agentId: NativeAgentId) => void;
  readonly onJumpToActivity?: (activityId: ActivityId) => void;
  readonly onJumpToWorkflow?: (workflowId: WorkflowId) => void;
}
