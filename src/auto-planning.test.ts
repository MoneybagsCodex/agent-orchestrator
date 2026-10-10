/**
 * Auto-Planning System Tests - 20+ test cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkDescriptionParser,
  PlanStepGenerator,
  DependencyAnalyzer,
  ConversationMonitor,
  AutoApprovalBridge,
  AutoPlanningOrchestrator,
  createAutoPlanning,
  type WorkDescription,
  type PlanStep,
  type AgentMessage,
} from './auto-planning';

describe('WorkDescriptionParser', () => {
  let parser: WorkDescriptionParser;

  beforeEach(() => {
    parser = new WorkDescriptionParser();
  });

  // Test 1: Detect "we need to" pattern
  it('detects "we need to" work description', () => {
    const text = 'We need to implement error recovery system';
    const result = parser.detectWorkDescription(text);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(50);
    expect(result!.workIndicators).toContain('requirement');
  });

  // Test 2: Detect "should implement" pattern
  it('detects "should implement" pattern', () => {
    const text = 'Should implement automated testing framework';
    const result = parser.detectWorkDescription(text);

    expect(result).not.toBeNull();
    expect(result!.workIndicators).toContain('suggestion');
  });

  // Test 3: Detect "let's build" pattern
  it('detects "let\'s build" pattern', () => {
    const text = "Let's build a monitoring dashboard for production";
    const result = parser.detectWorkDescription(text);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(70);
  });

  // Test 4: Reject non-work text
  it('rejects text without work indicators', () => {
    const text = 'The weather is nice today';
    const result = parser.detectWorkDescription(text);

    expect(result).toBeNull();
  });

  // Test 5: Extract multiple descriptions from message
  it('extracts multiple work descriptions from message', () => {
    const message =
      'We need to fix the authentication. Also, should implement rate limiting. And let\'s add monitoring.';
    const results = parser.extractFromMessage(message, 'agent-1');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].context.agentName).toBe('agent-1');
  });

  // Test 6: Reject too-short text
  it('rejects text shorter than 10 characters', () => {
    const text = 'fix bug';
    const result = parser.detectWorkDescription(text);

    expect(result).toBeNull();
  });

  // Test 7: Detect planning pattern
  it('detects planning pattern', () => {
    const text = 'We should design the architecture before implementation';
    const result = parser.detectWorkDescription(text);

    expect(result).not.toBeNull();
    expect(result!.workIndicators).toContain('planning');
  });

  // Test 8: Detect testing pattern
  it('detects testing pattern', () => {
    const text = 'Need to test the integration endpoints';
    const result = parser.detectWorkDescription(text);

    expect(result).not.toBeNull();
    expect(result!.workIndicators.some((ind) => ind === 'testing' || ind === 'action')).toBe(true);
  });
});

describe('PlanStepGenerator', () => {
  let generator: PlanStepGenerator;
  let mockDescription: WorkDescription;

  beforeEach(() => {
    generator = new PlanStepGenerator();
    mockDescription = {
      id: 'wd-1',
      rawText: 'We need to implement error recovery system with circuit breaker',
      detectedAt: Date.now(),
      confidence: 90,
      context: {},
      workIndicators: ['requirement', 'action'],
    };
  });

  // Test 9: Generate plan steps from description
  it('generates plan steps from work description', () => {
    const steps = generator.generateSteps(mockDescription);

    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].title).toBeTruthy();
    expect(steps[0].estimatedEffortMinutes).toBeGreaterThan(0);
  });

  // Test 10: Extract title from description
  it('extracts title from work description', () => {
    const steps = generator.generateSteps(mockDescription);

    expect(steps[0].title).not.toContain('we need to');
    expect(steps[0].title).toBeTruthy();
  });

  // Test 11: Large tasks get sub-steps
  it('generates sub-steps for large complex tasks', () => {
    const largeDescription: WorkDescription = {
      id: 'wd-2',
      rawText: 'We need to build a complete CI/CD pipeline with testing, deployment, and monitoring',
      detectedAt: Date.now(),
      confidence: 95,
      context: {},
      workIndicators: ['requirement'],
    };

    const steps = generator.generateSteps(largeDescription);

    // Large tasks (>240 min) should have sub-steps
    if (steps[0].estimatedEffortMinutes > 240) {
      expect(steps.length).toBeGreaterThan(1);
    }
  });

  // Test 12: Effort extraction from description
  it('estimates effort based on keywords', () => {
    const quickTask: WorkDescription = {
      id: 'wd-3',
      rawText: 'Quick fix for the login button styling',
      detectedAt: Date.now(),
      confidence: 80,
      context: {},
      workIndicators: ['action'],
    };

    const steps = generator.generateSteps(quickTask);

    expect(steps[0].estimatedEffortMinutes).toBeLessThan(500); // Should be less than 8 hours
  });

  // Test 13: Priority detection
  it('detects priority from description', () => {
    const criticalTask: WorkDescription = {
      id: 'wd-4',
      rawText: 'CRITICAL: Fix security vulnerability in authentication module ASAP',
      detectedAt: Date.now(),
      confidence: 95,
      context: {},
      workIndicators: ['action'],
    };

    const steps = generator.generateSteps(criticalTask);

    expect(['high', 'critical']).toContain(steps[0].priority);
  });

  // Test 14: Step ID generation
  it('generates step IDs with required format', () => {
    const steps = generator.generateSteps(mockDescription);

    expect(steps[0].id).toMatch(/^step-/);
    // All steps should have IDs
    steps.forEach((step) => {
      expect(step.id).toBeTruthy();
      expect(step.id.length).toBeGreaterThan(5);
    });
  });
});

describe('DependencyAnalyzer', () => {
  let analyzer: DependencyAnalyzer;
  let mockSteps: PlanStep[];

  beforeEach(() => {
    analyzer = new DependencyAnalyzer();
    mockSteps = [
      {
        id: 'step-1',
        title: 'Design',
        description: 'Design the system architecture',
        estimatedEffortMinutes: 480,
        status: 'pending',
        dependencies: [],
        priority: 'high',
        tags: ['design'],
      },
      {
        id: 'step-2',
        title: 'Implementation',
        description: 'Implement the design. This requires the design to be complete first.',
        estimatedEffortMinutes: 720,
        status: 'pending',
        dependencies: [],
        priority: 'high',
        tags: ['implementation'],
      },
      {
        id: 'step-3',
        title: 'Testing',
        description: 'Test the implementation after it is complete',
        estimatedEffortMinutes: 240,
        status: 'pending',
        dependencies: [],
        priority: 'medium',
        tags: ['testing'],
      },
    ];
  });

  // Test 15: Analyze dependencies
  it('analyzes dependencies between steps', () => {
    const deps = analyzer.analyzeDependencies(mockSteps);

    expect(deps.length).toBeGreaterThan(0);
    expect(deps[0]).toHaveProperty('fromStepId');
    expect(deps[0]).toHaveProperty('toStepId');
    expect(deps[0]).toHaveProperty('type');
  });

  // Test 16: Detect blocking relationships
  it('detects blocking relationships', () => {
    const deps = analyzer.analyzeDependencies(mockSteps);

    const blockingDeps = deps.filter((d) => d.type === 'requires');
    expect(blockingDeps.length).toBeGreaterThan(0);
  });

  // Test 17: Validate dependencies (no cycles)
  it('validates that dependencies have no cycles', () => {
    const deps = analyzer.analyzeDependencies(mockSteps);
    const isValid = analyzer.validateDependencies(mockSteps, deps);

    expect(isValid).toBe(true);
  });

  // Test 18: Detect circular dependencies
  it('detects circular dependencies', () => {
    const circularSteps: PlanStep[] = [
      { ...mockSteps[0], id: 'step-a' },
      { ...mockSteps[1], id: 'step-b' },
      { ...mockSteps[2], id: 'step-c' },
    ];

    const circularDeps = [
      { fromStepId: 'step-a', toStepId: 'step-b' },
      { fromStepId: 'step-b', toStepId: 'step-c' },
      { fromStepId: 'step-c', toStepId: 'step-a' }, // Creates cycle
    ];

    const isValid = analyzer.validateDependencies(circularSteps, circularDeps);

    expect(isValid).toBe(false);
  });
});

describe('ConversationMonitor', () => {
  let monitor: ConversationMonitor;
  const mockMessage: AgentMessage = {
    id: 'msg-1',
    agentName: 'agent-1',
    timestamp: Date.now(),
    content: 'We need to implement auto-approval for safe operations',
    messageType: 'planning',
  };

  beforeEach(() => {
    monitor = new ConversationMonitor();
  });

  // Test 19: Record agent messages
  it('records agent messages', () => {
    monitor.recordMessage(mockMessage);

    const context = monitor.getContext(10);
    expect(context).toContainEqual(mockMessage);
  });

  // Test 20: Detect work from recorded messages
  it('detects work descriptions from recorded messages', () => {
    monitor.recordMessage(mockMessage);

    const detected = monitor.getDetectedWork();
    expect(detected.length).toBeGreaterThan(0);
  });

  // Test 21: Clear detected work after processing
  it('clears detected work after processing', () => {
    monitor.recordMessage(mockMessage);
    expect(monitor.getDetectedWork().length).toBeGreaterThan(0);

    monitor.clearDetectedWork();
    expect(monitor.getDetectedWork()).toHaveLength(0);
  });

  // Test 22: Maintain conversation context
  it('maintains conversation context with limit', () => {
    for (let i = 0; i < 15; i++) {
      monitor.recordMessage({
        ...mockMessage,
        id: `msg-${i}`,
        timestamp: Date.now() + i,
      });
    }

    const context = monitor.getContext(5);
    expect(context.length).toBeLessThanOrEqual(5);
  });
});

describe('AutoApprovalBridge', () => {
  let bridge: AutoApprovalBridge;
  const mockPlan = {
    id: 'plan-1',
    title: 'Error Recovery System',
    description: 'Implement error recovery',
    steps: [],
    estimatedTotalMinutes: 480,
    createdAt: Date.now(),
    status: 'draft' as const,
    dependencies: [],
  };

  beforeEach(() => {
    bridge = new AutoApprovalBridge();
  });

  // Test 23: Propose plan without auto-commit
  it('proposes plan without auto-committing', () => {
    const proposed = bridge.proposePlan(mockPlan, 'system');

    expect(proposed.proposedBy).toBe('system');
    expect(proposed.approvalStatus).toBe('pending');
    expect(proposed.plan.status).toBe('draft');
  });

  // Test 24: Approve proposed plan
  it('approves proposed plan', () => {
    const proposed = bridge.proposePlan(mockPlan, 'system');
    const approved = bridge.approvePlan(proposed.plan.id);

    expect(approved).toBe(true);
    const pending = bridge.getPendingApprovals();
    expect(pending.find((p) => p.plan.id === mockPlan.id)).toBeUndefined();
  });

  // Test 25: Reject proposed plan
  it('rejects proposed plan', () => {
    const proposed = bridge.proposePlan(mockPlan, 'system');
    const rejected = bridge.rejectPlan(proposed.plan.id, 'Not ready yet');

    expect(rejected).toBe(true);
    const pending = bridge.getPendingApprovals();
    expect(pending.find((p) => p.plan.id === mockPlan.id)).toBeUndefined();
  });

  // Test 26: Get pending approvals
  it('retrieves pending approvals', () => {
    bridge.proposePlan(mockPlan, 'system');
    bridge.proposePlan({ ...mockPlan, id: 'plan-2' }, 'system');

    const pending = bridge.getPendingApprovals();
    expect(pending.length).toBeGreaterThanOrEqual(2);
  });

  // Test 27: Get approved plans
  it('retrieves approved plans', () => {
    const proposed = bridge.proposePlan(mockPlan, 'system');
    bridge.approvePlan(proposed.plan.id);

    const approved = bridge.getApprovedPlans();
    expect(approved.length).toBeGreaterThan(0);
    expect(approved[0].plan.id).toBe(mockPlan.id);
  });
});

describe('AutoPlanningOrchestrator', () => {
  let orchestrator: AutoPlanningOrchestrator;

  beforeEach(() => {
    orchestrator = new AutoPlanningOrchestrator();
  });

  // Test 28: Process agent message
  it('processes agent messages and generates plans', () => {
    const message: AgentMessage = {
      id: 'msg-1',
      agentName: 'agent-1',
      timestamp: Date.now(),
      content: 'We need to implement authentication system with OAuth2 support',
      messageType: 'planning',
    };

    const plans = orchestrator.processAgentMessage(message);

    expect(plans.length).toBeGreaterThan(0);
  });

  // Test 29: Generate plan from description
  it('generates complete plans from work descriptions', () => {
    const description = {
      id: 'wd-1',
      rawText: 'We need to build a monitoring dashboard',
      detectedAt: Date.now(),
      confidence: 90,
      context: { agentName: 'agent-1' },
      workIndicators: ['requirement'],
    };

    const plan = orchestrator.generatePlanFromDescription(description);

    expect(plan).not.toBeNull();
    expect(plan!.steps.length).toBeGreaterThan(0);
    expect(plan!.estimatedTotalMinutes).toBeGreaterThan(0);
  });

  // Test 30: Retrieve all generated plans
  it('retrieves all generated plans', () => {
    const message1: AgentMessage = {
      id: 'msg-1',
      agentName: 'agent-1',
      timestamp: Date.now(),
      content: 'We need to implement error recovery',
      messageType: 'planning',
    };

    const message2: AgentMessage = {
      id: 'msg-2',
      agentName: 'agent-2',
      timestamp: Date.now(),
      content: 'Should build a monitoring system',
      messageType: 'planning',
    };

    orchestrator.processAgentMessage(message1);
    orchestrator.processAgentMessage(message2);

    const plans = orchestrator.getPlans();
    expect(plans.length).toBeGreaterThan(0);
  });

  // Test 31: Integration test: full pipeline
  it('executes complete pipeline from message to approved plan', () => {
    const message: AgentMessage = {
      id: 'msg-1',
      agentName: 'agent-1',
      timestamp: Date.now(),
      content: 'We need to implement auto-scaling for the API service',
      messageType: 'planning',
    };

    const plans = orchestrator.processAgentMessage(message);
    expect(plans.length).toBeGreaterThan(0);

    const bridge = orchestrator.getApprovalBridge();
    const proposed = bridge.proposePlan(plans[0], 'orchestrator');
    expect(proposed.approvalStatus).toBe('pending');

    const approved = bridge.approvePlan(proposed.plan.id);
    expect(approved).toBe(true);
  });
});

describe('Factory function', () => {
  // Test 32: Create auto-planning system
  it('creates auto-planning system from factory', () => {
    const system = createAutoPlanning();

    expect(system).not.toBeNull();
    expect(system.getPlans).toBeDefined();
    expect(system.processAgentMessage).toBeDefined();
  });
});
