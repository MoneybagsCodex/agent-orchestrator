/**
 * State machine for workflow execution
 * Tracks phase states and manages transitions
 */

import type { Phase, PhaseState, Mission, ExecutionEvent } from './types.js';

export class WorkflowStateMachine {
  private phases: Map<string, Phase>;
  private executionLog: ExecutionEvent[] = [];

  constructor(phases: Phase[]) {
    this.phases = new Map(phases.map((p) => [p.id, p]));
  }

  /**
   * Transition a phase to a new state
   */
  transitionPhase(phaseId: string, newState: PhaseState, message: string): void {
    const phase = this.phases.get(phaseId);
    if (!phase) return;

    const oldState = phase.state;
    phase.state = newState;
    phase.startTime = phase.startTime || new Date();

    if (newState === 'done' || newState === 'failed') {
      phase.endTime = new Date();
      phase.duration = phase.endTime.getTime() - phase.startTime.getTime();
    }

    this.logEvent(phaseId, oldState === newState ? 'started' : newState, message);
  }

  /**
   * Get phases that are ready to run (all dependencies met)
   */
  getReadyPhases(edges: Map<string, string[]>): Phase[] {
    const ready: Phase[] = [];

    for (const phase of this.phases.values()) {
      if (phase.state !== 'queued' && phase.state !== 'ready') continue;

      // Check if all dependencies are done
      const allDependenciesDone = phase.dependsOn.every(
        (depId) => this.phases.get(depId)?.state === 'done'
      );

      if (allDependenciesDone) {
        ready.push(phase);
      }
    }

    return ready;
  }

  /**
   * Get phases that can run in parallel
   */
  getParallelizablePhases(readyPhases: Phase[]): Phase[][] {
    const groups: Phase[][] = [];
    const processed = new Set<string>();

    for (const phase of readyPhases) {
      if (processed.has(phase.id)) continue;

      const group = [phase];
      processed.add(phase.id);

      if (phase.parallelWith) {
        for (const parallelId of phase.parallelWith) {
          const parallelPhase = readyPhases.find((p) => p.id === parallelId);
          if (parallelPhase && !processed.has(parallelId)) {
            group.push(parallelPhase);
            processed.add(parallelId);
          }
        }
      }

      groups.push(group);
    }

    return groups;
  }

  /**
   * Get all phases
   */
  getAllPhases(): Phase[] {
    return Array.from(this.phases.values());
  }

  /**
   * Get execution log
   */
  getLog(): ExecutionEvent[] {
    return this.executionLog;
  }

  /**
   * Get progress
   */
  getProgress(): { completed: number; total: number; percentComplete: number } {
    const total = this.phases.size;
    const completed = Array.from(this.phases.values()).filter((p) => p.state === 'done')
      .length;
    return {
      completed,
      total,
      percentComplete: Math.round((completed / total) * 100),
    };
  }

  private logEvent(phaseId: string, event: string, message: string): void {
    this.executionLog.push({
      timestamp: new Date(),
      phaseId,
      event: event as any,
      message,
    });
  }
}
