/**
 * Agent router: assigns agents to phases based on capability matching
 */

import type { Phase, Agent } from './types.js';
import { AGENT_REGISTRY, getAgentByCapability } from './agent-registry.js';

export function assignAgentToPhase(phase: Phase): Agent | undefined {
  // Get agent with required capability
  const agent = getAgentByCapability(phase.requiredCapability);

  if (agent) {
    phase.assignedAgent = agent;
    return agent;
  }

  return undefined;
}

export function routeAllPhases(phases: Phase[]): Map<string, Agent> {
  const assignments = new Map<string, Agent>();

  for (const phase of phases) {
    const agent = assignAgentToPhase(phase);
    if (agent) {
      assignments.set(phase.id, agent);
    }
  }

  return assignments;
}
