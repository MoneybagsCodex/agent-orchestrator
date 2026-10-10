/**
 * Auto-Planning System - Phase 1
 * Detects work descriptions in agent prose and generates structured plans
 */

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  estimatedEffortMinutes: number;
  owner?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  dependencies: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
}

export interface WorkDescription {
  id: string;
  rawText: string;
  detectedAt: number;
  confidence: number; // 0-100
  context: {
    agentName?: string;
    messageId?: string;
    conversationId?: string;
  };
  workIndicators: string[];
}

export interface Plan {
  id: string;
  title: string;
  description: string;
  steps: PlanStep[];
  estimatedTotalMinutes: number;
  createdAt: number;
  status: 'draft' | 'proposed' | 'approved' | 'in_progress' | 'completed';
  dependencies: Array<{
    fromStepId: string;
    toStepId: string;
    type: 'blocks' | 'requires' | 'enhances';
  }>;
}

// ================================================================ Work Description Patterns

const WORK_PATTERNS = [
  { regex: /we\s+need\s+to|need\s+to\s+implement/i, type: 'requirement', weight: 0.9 },
  { regex: /should\s+implement|let's\s+build|let's\s+create/i, type: 'suggestion', weight: 0.85 },
  { regex: /todo|task:|implement|build|create|fix|add|refactor/i, type: 'action', weight: 0.8 },
  { regex: /design|architect|plan|strategy|approach/i, type: 'planning', weight: 0.75 },
  { regex: /phase\s+\d+|step\s+\d+|milestone/i, type: 'milestone', weight: 0.9 },
  { regex: /test|verify|validate|ensure|confirm/i, type: 'testing', weight: 0.7 },
  { regex: /integrate|connect|link|combine|merge/i, type: 'integration', weight: 0.75 },
  { regex: /document|guide|tutorial|readme|example/i, type: 'documentation', weight: 0.7 },
];

const EFFORT_INDICATORS = [
  { regex: /quick|easy|simple|trivial/i, effort: 30 },
  { regex: /hour|2-3\s*hours?|straightforward/i, effort: 120 },
  { regex: /day|few\s+days?|moderate/i, effort: 480 },
  { regex: /week|complex|significant/i, effort: 2400 },
  { regex: /month|major|substantial/i, effort: 10080 },
];

const PRIORITY_KEYWORDS = {
  critical: /critical|must|urgent|blocking/i,
  high: /high|important|asap/i,
  medium: /medium|soon/i,
  low: /low|eventually|nice-to-have/i,
};

// ================================================================ WorkDescriptionParser

export class WorkDescriptionParser {
  /**
   * Detect if text contains work description indicators
   */
  detectWorkDescription(text: string): WorkDescription | null {
    if (!text || text.length < 10) return null;

    const indicators: string[] = [];
    let maxConfidence = 0;

    // Check each pattern
    for (const pattern of WORK_PATTERNS) {
      if (pattern.regex.test(text)) {
        indicators.push(pattern.type);
        maxConfidence = Math.max(maxConfidence, pattern.weight * 100);
      }
    }

    if (maxConfidence < 50) return null;

    return {
      id: `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rawText: text.slice(0, 1000),
      detectedAt: Date.now(),
      confidence: Math.round(maxConfidence),
      context: {},
      workIndicators: indicators,
    };
  }

  /**
   * Extract work descriptions from agent message
   */
  extractFromMessage(message: string, agentName?: string): WorkDescription[] {
    const descriptions: WorkDescription[] = [];

    // Split by sentence boundaries
    const sentences = message.match(/[^.!?]+[.!?]+/g) || [message];

    for (const sentence of sentences) {
      const desc = this.detectWorkDescription(sentence.trim());
      if (desc) {
        desc.context.agentName = agentName;
        descriptions.push(desc);
      }
    }

    return descriptions;
  }
}

// ================================================================ PlanStepGenerator

export class PlanStepGenerator {
  /**
   * Generate plan steps from work description
   */
  generateSteps(description: WorkDescription): PlanStep[] {
    const steps: PlanStep[] = [];
    const text = description.rawText;

    // Extract effort estimate
    let effort = 120; // Default 2 hours
    for (const indicator of EFFORT_INDICATORS) {
      if (indicator.regex.test(text)) {
        effort = indicator.effort;
        break;
      }
    }

    // Determine priority
    let priority: 'low' | 'medium' | 'high' | 'critical' = 'medium';
    for (const [level, regex] of Object.entries(PRIORITY_KEYWORDS)) {
      if (regex.test(text)) {
        priority = level as 'low' | 'medium' | 'high' | 'critical';
        break;
      }
    }

    // Create main step
    const mainStep: PlanStep = {
      id: `step-${Date.now()}-0`,
      title: this.extractTitle(text),
      description: text,
      estimatedEffortMinutes: effort,
      status: 'pending',
      dependencies: [],
      priority,
      tags: description.workIndicators,
    };

    steps.push(mainStep);

    // Generate sub-steps based on complexity
    if (effort > 240) {
      // Large tasks get sub-steps
      const subSteps = this.generateSubSteps(text, mainStep.id, effort);
      steps.push(...subSteps);
    }

    return steps;
  }

  /**
   * Extract title from description text
   */
  private extractTitle(text: string): string {
    // Remove common prefixes
    let title = text
      .replace(/^(we\s+need\s+to|should|let's|todo:|task:)\s+/i, '')
      .replace(/\s*\([^)]*\)\s*$/, '') // Remove trailing parentheses
      .trim();

    // Capitalize and limit length
    title = title.charAt(0).toUpperCase() + title.slice(1);
    return title.slice(0, 100);
  }

  /**
   * Generate sub-steps for complex tasks
   */
  private generateSubSteps(text: string, parentId: string, totalEffort: number): PlanStep[] {
    const steps: PlanStep[] = [];
    const subEffort = Math.ceil(totalEffort / 3);

    const subTitles = [
      { title: 'Design & Planning', idx: 1 },
      { title: 'Implementation', idx: 2 },
      { title: 'Testing & Validation', idx: 3 },
    ];

    for (const sub of subTitles) {
      steps.push({
        id: `step-${Date.now()}-${sub.idx}`,
        title: sub.title,
        description: `${sub.title} for: ${text.slice(0, 100)}`,
        estimatedEffortMinutes: subEffort,
        status: 'pending',
        dependencies: sub.idx > 1 ? [`step-${Date.now()}-${sub.idx - 1}`] : [],
        priority: 'medium',
        tags: ['subtask'],
      });
    }

    return steps;
  }
}

// ================================================================ DependencyAnalyzer

export class DependencyAnalyzer {
  /**
   * Infer dependencies between steps based on text and keywords
   */
  analyzeDependencies(steps: PlanStep[]): Array<{ fromStepId: string; toStepId: string; type: string }> {
    const dependencies: Array<{ fromStepId: string; toStepId: string; type: string }> = [];

    const blockingKeywords = /before|first|then|after|once|depends/i;
    const enhancingKeywords = /also|additionally|further|improves|enhances/i;

    for (let i = 0; i < steps.length; i++) {
      for (let j = i + 1; j < steps.length; j++) {
        const step1 = steps[i];
        const step2 = steps[j];

        // Check for blocking relationships
        if (blockingKeywords.test(step2.description)) {
          dependencies.push({
            fromStepId: step1.id,
            toStepId: step2.id,
            type: 'blocks',
          });
        }

        // Check for requirement relationships
        if (/requires|needs/i.test(step2.description)) {
          dependencies.push({
            fromStepId: step1.id,
            toStepId: step2.id,
            type: 'requires',
          });
        }

        // Check for enhancement relationships
        if (enhancingKeywords.test(step2.description)) {
          dependencies.push({
            fromStepId: step1.id,
            toStepId: step2.id,
            type: 'enhances',
          });
        }
      }
    }

    return dependencies;
  }

  /**
   * Validate dependencies (detect cycles)
   */
  validateDependencies(steps: PlanStep[], dependencies: Array<{ fromStepId: string; toStepId: string }>): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (stepId: string): boolean => {
      visited.add(stepId);
      recursionStack.add(stepId);

      const deps = dependencies.filter((d) => d.fromStepId === stepId);
      for (const dep of deps) {
        if (!visited.has(dep.toStepId)) {
          if (hasCycle(dep.toStepId)) return true;
        } else if (recursionStack.has(dep.toStepId)) {
          return true;
        }
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (!visited.has(step.id)) {
        if (hasCycle(step.id)) return false;
      }
    }

    return true;
  }
}

// ================================================================ ConversationMonitor

export interface AgentMessage {
  id: string;
  agentName: string;
  timestamp: number;
  content: string;
  messageType: 'status' | 'request' | 'response' | 'planning' | 'other';
}

export class ConversationMonitor {
  private messages: AgentMessage[] = [];
  private detectedWorkDescriptions: WorkDescription[] = [];
  private parser = new WorkDescriptionParser();

  /**
   * Record agent message
   */
  recordMessage(message: AgentMessage): void {
    this.messages.push(message);

    // Check for work descriptions
    const descriptions = this.parser.extractFromMessage(message.content, message.agentName);
    this.detectedWorkDescriptions.push(...descriptions);
  }

  /**
   * Get all detected work descriptions
   */
  getDetectedWork(): WorkDescription[] {
    return [...this.detectedWorkDescriptions];
  }

  /**
   * Clear detected work (after processing)
   */
  clearDetectedWork(): void {
    this.detectedWorkDescriptions = [];
  }

  /**
   * Get conversation context (last N messages)
   */
  getContext(limit: number = 10): AgentMessage[] {
    return this.messages.slice(-limit);
  }
}

// ================================================================ AutoApprovalBridge

export interface ProposedPlan {
  plan: Plan;
  proposedAt: number;
  proposedBy: string;
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'expired';
  approvedAt?: number;
}

export class AutoApprovalBridge {
  private proposedPlans: ProposedPlan[] = [];

  /**
   * Propose a plan (never auto-commit)
   */
  proposePlan(plan: Plan, proposedBy: string = 'system'): ProposedPlan {
    const proposed: ProposedPlan = {
      plan,
      proposedAt: Date.now(),
      proposedBy,
      approvalStatus: 'pending',
    };

    this.proposedPlans.push(proposed);
    console.log(`[auto-planning-proposal] Plan "${plan.title}" proposed by ${proposedBy}`);

    return proposed;
  }

  /**
   * Approve a proposed plan
   */
  approvePlan(planId: string): boolean {
    const proposed = this.proposedPlans.find((p) => p.plan.id === planId);
    if (!proposed) return false;

    proposed.approvalStatus = 'approved';
    proposed.approvedAt = Date.now();
    proposed.plan.status = 'approved';

    console.log(`[auto-planning-approved] Plan "${proposed.plan.title}" approved`);
    return true;
  }

  /**
   * Reject a proposed plan
   */
  rejectPlan(planId: string, reason?: string): boolean {
    const proposed = this.proposedPlans.find((p) => p.plan.id === planId);
    if (!proposed) return false;

    proposed.approvalStatus = 'rejected';
    proposed.plan.status = 'draft';

    console.log(`[auto-planning-rejected] Plan "${proposed.plan.title}" rejected${reason ? `: ${reason}` : ''}`);
    return true;
  }

  /**
   * Get all pending approvals
   */
  getPendingApprovals(): ProposedPlan[] {
    return this.proposedPlans.filter((p) => p.approvalStatus === 'pending');
  }

  /**
   * Get approved plans
   */
  getApprovedPlans(): ProposedPlan[] {
    return this.proposedPlans.filter((p) => p.approvalStatus === 'approved');
  }
}

// ================================================================ AutoPlanningOrchestrator

export class AutoPlanningOrchestrator {
  private parser = new WorkDescriptionParser();
  private generator = new PlanStepGenerator();
  private analyzer = new DependencyAnalyzer();
  private monitor = new ConversationMonitor();
  private bridge = new AutoApprovalBridge();
  private generatedPlans: Plan[] = [];

  /**
   * Process a work description and generate a plan
   */
  generatePlanFromDescription(description: WorkDescription): Plan | null {
    const steps = this.generator.generateSteps(description);
    if (steps.length === 0) return null;

    const dependencies = this.analyzer.analyzeDependencies(steps);
    const isValid = this.analyzer.validateDependencies(steps, dependencies);

    if (!isValid) {
      console.log(`[auto-planning-error] Circular dependency detected in plan`);
      return null;
    }

    const totalEffort = steps.reduce((sum, s) => sum + s.estimatedEffortMinutes, 0);

    const plan: Plan = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: steps[0].title,
      description: description.rawText,
      steps,
      estimatedTotalMinutes: totalEffort,
      createdAt: Date.now(),
      status: 'draft',
      dependencies: dependencies.map((d) => ({
        fromStepId: d.fromStepId,
        toStepId: d.toStepId,
        type: d.type,
      })),
    };

    this.generatedPlans.push(plan);
    return plan;
  }

  /**
   * Process agent message and auto-detect work
   */
  processAgentMessage(message: AgentMessage): Plan[] {
    this.monitor.recordMessage(message);

    const descriptions = this.parser.extractFromMessage(message.content, message.agentName);
    const plans: Plan[] = [];

    for (const desc of descriptions) {
      const plan = this.generatePlanFromDescription(desc);
      if (plan) {
        plans.push(plan);
      }
    }

    return plans;
  }

  /**
   * Get all generated plans
   */
  getPlans(): Plan[] {
    return [...this.generatedPlans];
  }

  /**
   * Access approval bridge
   */
  getApprovalBridge(): AutoApprovalBridge {
    return this.bridge;
  }
}

/**
 * Create configured auto-planning system
 */
export function createAutoPlanning(config?: any): AutoPlanningOrchestrator {
  return new AutoPlanningOrchestrator();
}
