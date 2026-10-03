/**
 * Mission parser: takes natural language mission and returns workflow DAG
 * For demo, uses hardcoded workflow templates
 */

import type { Phase, WorkflowDAG, ConditionalRule } from './types.js';

export function parseMission(missionString: string): WorkflowDAG & { id: string; title: string } {
  const lowerMission = missionString.toLowerCase();
  const id = 'mission-' + Date.now();

  // Hardcoded workflows for demo
  if (
    lowerMission.includes('deploy') ||
    lowerMission.includes('release') ||
    lowerMission.includes('production')
  ) {
    return { ...createDeploymentWorkflow(missionString), id, title: missionString };
  } else if (lowerMission.includes('test') || lowerMission.includes('check')) {
    return { ...createTestingWorkflow(missionString), id, title: missionString };
  } else if (lowerMission.includes('analyze') || lowerMission.includes('review')) {
    return { ...createAnalysisWorkflow(missionString), id, title: missionString };
  }

  // Default: generic workflow
  return { ...createGenericWorkflow(missionString), id, title: missionString };
}

function createDeploymentWorkflow(mission: string): WorkflowDAG {
  const phases: Phase[] = [
    {
      id: 'phase-1-test',
      type: 'run-tests',
      description: 'Run comprehensive test suite',
      requiredCapability: 'run-tests',
      state: 'queued',
      dependsOn: [],
      condition: {
        if: 'test-results.passed == true',
        then: 'continue',
        else: 'halt',
      },
    },
    {
      id: 'phase-2a-perf',
      type: 'performance-analysis',
      description: 'Analyze performance impact',
      requiredCapability: 'performance-analysis',
      state: 'queued',
      dependsOn: ['phase-1-test'],
      parallelWith: ['phase-2b-security'],
      condition: {
        if: 'perf-report.degradation > 5%',
        then: 'flag-risk',
        else: 'continue',
      },
    },
    {
      id: 'phase-2b-security',
      type: 'security-scan',
      description: 'Run security audit',
      requiredCapability: 'security-scan',
      state: 'queued',
      dependsOn: ['phase-1-test'],
      parallelWith: ['phase-2a-perf'],
      condition: {
        if: 'security-report.vulnerabilities > 0',
        then: 'halt',
        else: 'continue',
      },
    },
    {
      id: 'phase-3-integration',
      type: 'integration-tests',
      description: 'Run integration tests',
      requiredCapability: 'integration-tests',
      state: 'queued',
      dependsOn: ['phase-2a-perf', 'phase-2b-security'],
    },
    {
      id: 'phase-4-approval',
      type: 'human-approval',
      description: 'Await human approval',
      requiredCapability: 'human-approval',
      state: 'queued',
      dependsOn: ['phase-3-integration'],
    },
    {
      id: 'phase-5-deploy',
      type: 'deploy',
      description: 'Deploy to staging',
      requiredCapability: 'deploy',
      state: 'queued',
      dependsOn: ['phase-4-approval'],
    },
    {
      id: 'phase-6-monitor',
      type: 'monitoring',
      description: 'Monitor for 24 hours',
      requiredCapability: 'monitoring',
      state: 'queued',
      dependsOn: ['phase-5-deploy'],
    },
  ];

  const edges = new Map<string, string[]>();
  edges.set('phase-1-test', ['phase-2a-perf', 'phase-2b-security']);
  edges.set('phase-2a-perf', ['phase-3-integration']);
  edges.set('phase-2b-security', ['phase-3-integration']);
  edges.set('phase-3-integration', ['phase-4-approval']);
  edges.set('phase-4-approval', ['phase-5-deploy']);
  edges.set('phase-5-deploy', ['phase-6-monitor']);

  return { phases, edges };
}

function createTestingWorkflow(mission: string): WorkflowDAG {
  const phases: Phase[] = [
    {
      id: 'phase-1-unit-tests',
      type: 'unit-tests',
      description: 'Run unit tests',
      requiredCapability: 'unit-tests',
      state: 'queued',
      dependsOn: [],
    },
    {
      id: 'phase-2-integration-tests',
      type: 'integration-tests',
      description: 'Run integration tests',
      requiredCapability: 'integration-tests',
      state: 'queued',
      dependsOn: ['phase-1-unit-tests'],
    },
    {
      id: 'phase-3-analysis',
      type: 'test-analysis',
      description: 'Analyze test results',
      requiredCapability: 'test-analysis',
      state: 'queued',
      dependsOn: ['phase-2-integration-tests'],
    },
  ];

  const edges = new Map<string, string[]>();
  edges.set('phase-1-unit-tests', ['phase-2-integration-tests']);
  edges.set('phase-2-integration-tests', ['phase-3-analysis']);

  return { phases, edges };
}

function createAnalysisWorkflow(mission: string): WorkflowDAG {
  const phases: Phase[] = [
    {
      id: 'phase-1-perf',
      type: 'performance-analysis',
      description: 'Analyze performance',
      requiredCapability: 'performance-analysis',
      state: 'queued',
      dependsOn: [],
    },
    {
      id: 'phase-2-security',
      type: 'security-scan',
      description: 'Security audit',
      requiredCapability: 'security-scan',
      state: 'queued',
      dependsOn: [],
      parallelWith: ['phase-1-perf'],
    },
  ];

  const edges = new Map<string, string[]>();

  return { phases, edges };
}

function createGenericWorkflow(mission: string): WorkflowDAG {
  const phases: Phase[] = [
    {
      id: 'phase-1-analyze',
      type: 'analysis',
      description: 'Analyze request',
      requiredCapability: 'performance-analysis',
      state: 'queued',
      dependsOn: [],
    },
    {
      id: 'phase-2-execute',
      type: 'execution',
      description: 'Execute task',
      requiredCapability: 'deploy',
      state: 'queued',
      dependsOn: ['phase-1-analyze'],
    },
  ];

  const edges = new Map<string, string[]>();
  edges.set('phase-1-analyze', ['phase-2-execute']);

  return { phases, edges };
}
