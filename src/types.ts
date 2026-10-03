/**
 * Core types for the orchestration system
 */

export type PhaseState = 'queued' | 'ready' | 'running' | 'done' | 'failed' | 'blocked';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  skillLevel: 'novice' | 'intermediate' | 'expert';
  specialization: string;
}

export interface Phase {
  id: string;
  type: string;
  description: string;
  requiredCapability: string;
  assignedAgent?: Agent;
  state: PhaseState;
  output?: Record<string, any>;
  dependsOn: string[]; // phase IDs
  parallelWith?: string[]; // phase IDs that can run simultaneously
  condition?: ConditionalRule;
  startTime?: Date;
  endTime?: Date;
  duration?: number; // ms
}

export interface ConditionalRule {
  if: string; // "test-results.passed == true"
  then: string; // "continue" or "halt"
  else?: string; // "analyze" or "halt"
}

export interface WorkflowDAG {
  phases: Phase[];
  edges: Map<string, string[]>; // phase ID -> dependent phase IDs
}

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: 'planning' | 'ready' | 'executing' | 'done' | 'failed';
  workflow: WorkflowDAG;
  riskPolicy: {
    autoApproveUnder: RiskLevel;
    requireApprovalOver: RiskLevel;
    blockOn: RiskLevel;
  };
  currentRiskLevel: RiskLevel;
  progress: {
    completed: number;
    total: number;
    percentComplete: number;
  };
  executionLog: ExecutionEvent[];
}

export interface ExecutionEvent {
  timestamp: Date;
  phaseId: string;
  event: 'started' | 'completed' | 'failed' | 'blocked' | 'awaiting_approval';
  message: string;
  data?: Record<string, any>;
}

export interface MasterAgentInput {
  type: 'voice' | 'text';
  content: string;
}

export interface MasterAgentOutput {
  understood: boolean;
  confidence: number;
  intent: string;
  workflow: WorkflowDAG;
  agentAssignments: Map<string, Agent>;
  summary: string;
}
