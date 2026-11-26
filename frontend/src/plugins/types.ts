import type React from 'react';
import type {
  ApprovalPolicy,
  BridgeStatus,
  CardPayload,
  ConversationTelemetry,
  PermissionTier,
} from '../api/client';

export type SlotId = 'bottom-capsule' | 'message-card' | 'quick-toolbar' | 'drawer-panel';

export interface CapsuleSlotProps {
  model: string;
  modelDisplayLabel?: string;
  permissionMode: PermissionTier;
  approvalPolicy?: ApprovalPolicy;
  bridgeStatus?: BridgeStatus | null;
  telemetry?: ConversationTelemetry | null;
  agentStatus: 'idle' | 'thinking' | 'running' | 'error' | 'aborted';
  preventSleep: boolean;
  usageSummary?: string;
  onCyclePermission: () => void;
  onCycleApprovalPolicy?: () => void;
  onAbort: () => void;
  onOpenSettings: () => void;
  onOpenModelPicker?: () => void;
}

export interface CardRendererProps<T = Record<string, unknown>> {
  payload: CardPayload<T>;
  onAction: (pluginId: string, actionId: string, data?: Record<string, unknown>) => void;
}

export interface AgyPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  slots?: {
    'bottom-capsule'?: React.ComponentType<CapsuleSlotProps>;
  };
  cards?: Record<string, React.ComponentType<CardRendererProps<any>>>;
}
