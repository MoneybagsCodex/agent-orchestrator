/**
 * Main orchestrator: coordinates workflow execution
 */

import type { Mission, WorkflowDAG, RiskLevel, Agent } from './types.js';
import { WorkflowStateMachine } from './state-machine.js';
import { routeAllPhases } from './router.js';

export class Orchestrator {
  private stateMachine: WorkflowStateMachine;
  workflow: WorkflowDAG;
  private agentAssignments: Map<string, Agent>;
  private riskLevel: RiskLevel = 'low';
  executionEvents: Array<{ timestamp: string; type: string; message: string }> = [];

  constructor(workflow: WorkflowDAG) {
    this.workflow = workflow;
    this.stateMachine = new WorkflowStateMachine(workflow.phases);
    this.agentAssignments = routeAllPhases(workflow.phases);
  }

  /**
   * Initialize the workflow: assign agents and mark phases as ready
   */
  initialize(): void {
    // Mark all phases with no dependencies as ready
    for (const phase of this.workflow.phases) {
      if (phase.dependsOn.length === 0) {
        this.stateMachine.transitionPhase(phase.id, 'ready', `Assigned to ${phase.assignedAgent?.name || 'unknown'}`);
      }
    }
  }

  /**
   * Execute one step of the workflow
   */
  executeStep(phaseId: string): { success: boolean; output?: Record<string, any> } {
    const phase = this.workflow.phases.find((p) => p.id === phaseId);
    if (!phase) return { success: false };

    // Simulate execution
    this.stateMachine.transitionPhase(phaseId, 'running', `Executing on ${phase.assignedAgent?.name}`);

    // Simulate some work
    const simulatedOutput = this.simulatePhaseExecution(phase);
    phase.output = simulatedOutput;

    // Check conditions
    const shouldContinue = this.evaluateConditions(phase, simulatedOutput);

    if (shouldContinue) {
      this.stateMachine.transitionPhase(phaseId, 'done', `Completed successfully`);
      this.updateRiskLevel(phaseId, simulatedOutput);
      return { success: true, output: simulatedOutput };
    } else {
      this.stateMachine.transitionPhase(
        phaseId,
        'blocked',
        `Blocked: condition not met. Manual approval required.`
      );
      return { success: false, output: simulatedOutput };
    }
  }

  /**
   * Get the next phases to execute
   */
  getNextPhasesToExecute(): string[] {
    const readyPhases = this.stateMachine.getReadyPhases(this.workflow.edges);
    return readyPhases.map((p: any) => p.id);
  }

  /**
   * Get current execution state
   */
  getExecutionState(): {
    phases: any[];
    progress: any;
    riskLevel: RiskLevel;
    log: any[];
  } {
    return {
      phases: this.stateMachine.getAllPhases().map((p) => ({
        id: p.id,
        type: p.type,
        description: p.description,
        state: p.state,
        agent: p.assignedAgent?.name,
        duration: p.duration,
      })),
      progress: this.stateMachine.getProgress(),
      riskLevel: this.riskLevel,
      log: this.stateMachine.getLog(),
    };
  }

  /**
   * Get progress
   */
  getProgress(): any {
    return this.stateMachine.getProgress();
  }

  /**
   * Get risk level
   */
  getRiskLevel(): RiskLevel {
    return this.riskLevel;
  }

  private simulatePhaseExecution(phase: any): Record<string, any> {
    // Mock different outcomes based on phase type
    if (phase.type === 'run-tests') {
      return {
        testsRun: 147,
        passed: 145,
        failed: 2,
        allPassed: true,
        coverage: 87,
      };
    } else if (phase.type === 'performance-analysis') {
      return {
        baselineMs: 145,
        currentMs: 157,
        degradation: 8.3,
        degradation_percent: 8.3,
      };
    } else if (phase.type === 'security-scan') {
      return {
        vulnerabilities: 0,
        warnings: 2,
        critical: false,
      };
    }
    return { status: 'completed' };
  }

  private evaluateConditions(phase: any, output: Record<string, any>): boolean {
    if (!phase.condition) return true;

    const { if: condition, then: thenAction, else: elseAction } = phase.condition;

    // Simple condition evaluation
    if (condition.includes('test') && output.passed) return true;
    if (condition.includes('degradation') && output.degradation_percent > 5) {
      this.riskLevel = 'medium';
      return true; // Flag risk but continue
    }
    if (condition.includes('vulnerabilities') && output.vulnerabilities > 0) return false;

    return true;
  }

  private updateRiskLevel(phaseId: string, output: Record<string, any>): void {
    if (output.degradation_percent && output.degradation_percent > 5) {
      this.riskLevel = 'medium';
    }
  }
}
