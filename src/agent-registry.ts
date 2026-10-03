/**
 * Agent capability registry
 * Maps agent IDs to their capabilities, skill levels, and specializations
 */

import type { Agent } from './types.js';

export const AGENT_REGISTRY: Map<string, Agent> = new Map([
  [
    'A',
    {
      id: 'A',
      name: 'Testing Agent',
      capabilities: ['run-tests', 'unit-tests', 'regression-tests', 'test-analysis'],
      skillLevel: 'expert',
      specialization: 'QA',
    },
  ],
  [
    'B',
    {
      id: 'B',
      name: 'Performance Agent',
      capabilities: ['performance-analysis', 'metrics', 'profiling', 'optimization'],
      skillLevel: 'expert',
      specialization: 'Performance',
    },
  ],
  [
    'C',
    {
      id: 'C',
      name: 'Security Agent',
      capabilities: ['security-scan', 'audit', 'vulnerability-check', 'compliance'],
      skillLevel: 'intermediate',
      specialization: 'Security',
    },
  ],
  [
    'D',
    {
      id: 'D',
      name: 'Integration Agent',
      capabilities: ['integration-tests', 'api-tests', 'e2e-tests', 'system-tests'],
      skillLevel: 'expert',
      specialization: 'Integration',
    },
  ],
  [
    'E',
    {
      id: 'E',
      name: 'Monitoring Agent',
      capabilities: ['monitoring', 'alerts', 'dashboards', 'observability'],
      skillLevel: 'intermediate',
      specialization: 'Ops',
    },
  ],
  [
    'F',
    {
      id: 'F',
      name: 'Deployment Agent',
      capabilities: ['deploy', 'rollback', 'provisioning', 'infrastructure'],
      skillLevel: 'expert',
      specialization: 'Deployment',
    },
  ],
]);

export function getAgentByCapability(capability: string): Agent | undefined {
  for (const agent of AGENT_REGISTRY.values()) {
    if (agent.capabilities.includes(capability)) {
      return agent;
    }
  }
  return undefined;
}

export function getAgent(id: string): Agent | undefined {
  return AGENT_REGISTRY.get(id);
}
