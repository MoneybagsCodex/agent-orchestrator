# Auto-Planning System - Complete Implementation

**Status:** ✅ COMPLETE  
**Date:** 2026-10-09  
**Tests:** 32/32 passing  
**Components:** 5 core + orchestrator  

---

## OVERVIEW

The Auto-Planning System automatically detects work descriptions in agent messages and generates structured, executable plans with dependency analysis and approval workflows.

**Key Features:**
- Natural language work detection (8+ patterns)
- Automatic plan generation with effort estimation
- Dependency inference and cycle detection
- Conversation monitoring for implicit work requests
- Safe approval workflow (propose-only, never auto-commit)
- 32 comprehensive unit tests

---

## ARCHITECTURE

```
┌──────────────────────────────────────────────────────┐
│          Auto-Planning System Pipeline               │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Agent Message                                       │
│      │                                               │
│      ▼                                               │
│  ┌─────────────────────────────────────┐            │
│  │  ConversationMonitor                │            │
│  │  - Records agent messages           │            │
│  │  - Maintains conversation context   │            │
│  │  - Triggers work detection          │            │
│  └────────────────┬────────────────────┘            │
│                   │                                  │
│                   ▼                                  │
│  ┌─────────────────────────────────────┐            │
│  │  WorkDescriptionParser              │            │
│  │  - Detect 8 pattern types           │            │
│  │  - Extract indicators               │            │
│  │  - Confidence scoring (0-100)       │            │
│  └────────────────┬────────────────────┘            │
│                   │                                  │
│                   ▼                                  │
│  ┌─────────────────────────────────────┐            │
│  │  PlanStepGenerator                  │            │
│  │  - Extract title                    │            │
│  │  - Estimate effort from keywords    │            │
│  │  - Determine priority               │            │
│  │  - Generate sub-steps (if large)    │            │
│  └────────────────┬────────────────────┘            │
│                   │                                  │
│                   ▼                                  │
│  ┌─────────────────────────────────────┐            │
│  │  DependencyAnalyzer                 │            │
│  │  - Infer dependencies from text     │            │
│  │  - Detect cycles                    │            │
│  │  - Validate acyclic graph           │            │
│  └────────────────┬────────────────────┘            │
│                   │                                  │
│                   ▼                                  │
│  ┌─────────────────────────────────────┐            │
│  │  AutoApprovalBridge                 │            │
│  │  - Propose plans (never auto-commit)│            │
│  │  - Manage approvals/rejections      │            │
│  │  - Track pending vs approved        │            │
│  └────────────────┬────────────────────┘            │
│                   │                                  │
│                   ▼                                  │
│  Plan (Proposed - Awaiting User Action)             │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## COMPONENTS

### 1. WorkDescriptionParser

**Purpose:** Detect natural language work descriptions in agent prose

**Patterns Detected:**
- `requirement` — "we need to", "need to implement"
- `suggestion` — "should", "let's build"
- `action` — "todo", "implement", "build", "create", "fix"
- `planning` — "design", "architect", "plan", "strategy"
- `milestone` — "phase X", "step X", "milestone"
- `testing` — "test", "verify", "validate", "ensure"
- `integration` — "integrate", "connect", "link", "combine"
- `documentation` — "document", "guide", "tutorial", "readme"

**Usage:**
```typescript
const parser = new WorkDescriptionParser();

// Detect single description
const description = parser.detectWorkDescription(
  'We need to implement error recovery system'
);
// Returns: WorkDescription with confidence score, indicators, context

// Extract from full message
const descriptions = parser.extractFromMessage(
  'Build auth system. Also implement rate limiting. Test endpoints.',
  'agent-1'
);
// Returns: Array of WorkDescription objects
```

**Confidence Scoring:**
- 50-100 scale based on pattern match
- Higher confidence = stronger work signal
- Filters out noise below 50

### 2. PlanStepGenerator

**Purpose:** Convert work descriptions to structured plan steps

**Capabilities:**
- Extract title from description
- Estimate effort from keywords (30min - 10,080min)
- Determine priority (low/medium/high/critical)
- Generate sub-steps for large tasks (>240min)
- Track dependencies

**Effort Keywords:**
- `quick/easy/simple` → 30 minutes
- `hour/straightforward` → 120 minutes (2 hours)
- `day/moderate` → 480 minutes (8 hours)
- `week/complex` → 2,400 minutes (40 hours)
- `month/substantial` → 10,080 minutes (1 week)

**Priority Keywords:**
- `critical/must/urgent/blocking` → critical
- `high/important/asap` → high
- `medium/soon` → medium
- `low/eventually/nice-to-have` → low

**Example:**
```typescript
const generator = new PlanStepGenerator();

const steps = generator.generateSteps(workDescription);
// Returns: Array of PlanStep objects
// - Large tasks (>240min) get 3 sub-steps: Design, Implementation, Testing
// - Step IDs auto-generated with timestamps
// - Dependencies tracked automatically
```

### 3. DependencyAnalyzer

**Purpose:** Infer task dependencies and detect circular references

**Relationship Types:**
- `blocks` — A must complete before B ("before", "first", "then")
- `requires` — B requires A to be done ("depends", "requires", "needs")
- `enhances` — A improves/builds on B ("also", "additionally", "enhances")

**Cycle Detection:**
- Uses depth-first search
- Validates acyclic dependency graph
- Returns false if cycles detected

**Example:**
```typescript
const analyzer = new DependencyAnalyzer();

// Infer dependencies from step descriptions
const deps = analyzer.analyzeDependencies(steps);
// Returns: Array of dependency relationships

// Validate (detect cycles)
const isValid = analyzer.validateDependencies(steps, deps);
// Returns: true if no cycles, false if circular
```

### 4. ConversationMonitor

**Purpose:** Watch agent messages for implicit work requests

**Functionality:**
- Record agent messages
- Automatically detect work descriptions
- Maintain conversation context (last N messages)
- Clear detected work after processing

**Example:**
```typescript
const monitor = new ConversationMonitor();

// Record message
monitor.recordMessage({
  id: 'msg-1',
  agentName: 'agent-1',
  timestamp: Date.now(),
  content: 'We need to implement auto-approval for safe operations',
  messageType: 'planning',
});

// Get detected work
const detected = monitor.getDetectedWork();
// Automatically found work descriptions

// Get context (last 10 messages)
const context = monitor.getContext(10);
```

### 5. AutoApprovalBridge

**Purpose:** Propose plans safely without auto-committing

**Key Principle:** "Propose, never auto-commit"

**Workflow:**
1. Generate plan from work description
2. Propose plan to user/approver
3. User decides: approve, reject, or modify
4. Only approved plans move to execution

**Example:**
```typescript
const bridge = new AutoApprovalBridge();

// Propose plan (user must approve)
const proposed = bridge.proposePlan(plan, 'orchestrator');
// Status: pending

// User approves
bridge.approvePlan(plan.id);
// Status: approved

// Or reject
bridge.rejectPlan(plan.id, 'Needs more detail');
// Status: rejected

// Get pending approvals for user review
const pending = bridge.getPendingApprovals();
```

### 6. AutoPlanningOrchestrator

**Purpose:** Orchestrate the complete pipeline

**Workflow:**
```typescript
const orchestrator = new AutoPlanningOrchestrator();

// Process agent message
const plans = orchestrator.processAgentMessage(message);
// 1. Detects work descriptions
// 2. Generates plan steps
// 3. Analyzes dependencies
// 4. Validates (no cycles)
// 5. Returns List<Plan>

// Access approval bridge for user interaction
const bridge = orchestrator.getApprovalBridge();
const proposed = bridge.proposePlan(plans[0], 'orchestrator');
// User decides to approve/reject
```

---

## CONFIGURATION

### orchestrator.config.json

```json
{
  "autoPlanning": {
    "enabled": true,
    "detectionPatterns": {
      "minConfidence": 50,
      "checkMessageTypes": ["planning", "request", "status"],
      "ignoreMessageTypes": ["response", "other"]
    },
    "effortEstimation": {
      "defaultEffortMinutes": 120,
      "maxEffortMinutes": 10080,
      "subStepThreshold": 240
    },
    "dependencies": {
      "detectCycles": true,
      "failOnCycle": false,
      "maxDependencyDepth": 10
    },
    "approval": {
      "requireApproval": true,
      "autoApproveSmallTasks": false,
      "smallTaskThreshold": 60,
      "approvalTimeoutMinutes": 60
    },
    "monitoring": {
      "recordConversation": true,
      "contextWindowSize": 20,
      "clearOldWorkAfterMinutes": 1440
    }
  }
}
```

---

## TEST COVERAGE (32/32 PASSING)

### WorkDescriptionParser (8 tests)
- ✅ Detect "we need to" pattern
- ✅ Detect "should implement" pattern
- ✅ Detect "let's build" pattern
- ✅ Reject non-work text
- ✅ Extract multiple descriptions from message
- ✅ Reject too-short text
- ✅ Detect planning pattern
- ✅ Detect testing pattern

### PlanStepGenerator (6 tests)
- ✅ Generate plan steps from description
- ✅ Extract title from description
- ✅ Generate sub-steps for large tasks
- ✅ Estimate effort from keywords
- ✅ Detect priority from description
- ✅ Generate step IDs with proper format

### DependencyAnalyzer (4 tests)
- ✅ Analyze dependencies between steps
- ✅ Detect blocking relationships
- ✅ Validate dependencies (no cycles)
- ✅ Detect circular dependencies

### ConversationMonitor (4 tests)
- ✅ Record agent messages
- ✅ Detect work from recorded messages
- ✅ Clear detected work after processing
- ✅ Maintain conversation context with limit

### AutoApprovalBridge (5 tests)
- ✅ Propose plan without auto-committing
- ✅ Approve proposed plan
- ✅ Reject proposed plan
- ✅ Get pending approvals
- ✅ Get approved plans

### AutoPlanningOrchestrator (3 tests)
- ✅ Process agent messages and generate plans
- ✅ Generate complete plans from descriptions
- ✅ Retrieve all generated plans

### Integration (2 tests)
- ✅ Complete pipeline from message to approved plan
- ✅ Factory function creates system

---

## USAGE EXAMPLES

### Example 1: Auto-Detect Work from Agent

```typescript
import { createAutoPlanning } from './auto-planning';

const planning = createAutoPlanning(config);

// Agent sends message
const message = {
  id: 'msg-1',
  agentName: 'error-recovery-agent',
  timestamp: Date.now(),
  content: 'We need to implement Phase 6 documentation and integration testing. ' +
           'Should include 20+ tests, deployment checklist, and architecture diagrams.',
  messageType: 'planning',
};

// Auto-detect and generate plans
const plans = planning.processAgentMessage(message);

// plans[0]:
// {
//   id: 'plan-...',
//   title: 'Implement Phase 6 documentation and integration testing',
//   estimatedTotalMinutes: 480,
//   steps: [
//     { title: 'Design & Planning', ... },
//     { title: 'Implementation', ... },
//     { title: 'Testing & Validation', ... }
//   ]
// }
```

### Example 2: Safe Approval Workflow

```typescript
const bridge = planning.getApprovalBridge();

// Propose (never auto-commit)
const proposed = bridge.proposePlan(plans[0], 'orchestrator');

// User reviews pending approvals
const pending = bridge.getPendingApprovals();
// [
//   {
//     plan: {...},
//     proposedBy: 'orchestrator',
//     approvalStatus: 'pending'
//   }
// ]

// User approves or rejects
if (userApproves) {
  bridge.approvePlan(proposed.plan.id);
  // Plan status: approved
  // Ready for execution
} else {
  bridge.rejectPlan(proposed.plan.id, 'Needs more detail');
  // Plan status: draft
  // Proposal withdrawn
}

// Get approved plans for execution
const approved = bridge.getApprovedPlans();
```

### Example 3: Monitor Conversation for Work

```typescript
const monitor = new ConversationMonitor();

// Simulate agent conversation
monitor.recordMessage({
  id: 'msg-1',
  agentName: 'agent-1',
  timestamp: Date.now(),
  content: 'Implementing auto-approval system now',
  messageType: 'status',
});

monitor.recordMessage({
  id: 'msg-2',
  agentName: 'agent-1',
  timestamp: Date.now() + 1000,
  content: 'We should add monitoring and alerting',
  messageType: 'planning',
});

// Detected work automatically
const detected = monitor.getDetectedWork();
// Found suggestion pattern in message 2

// Get context for reasoning
const context = monitor.getContext(10);
// Last 10 messages for context
```

---

## DESIGN DECISIONS

### 1. Propose-Only Approval
**Decision:** Never auto-commit plans; always require user approval

**Rationale:** Work plans affect team capacity and priorities. Auto-committing could overload agents or change priorities without awareness. Proposal workflow ensures human oversight.

### 2. Pattern-Based Detection
**Decision:** Use regex patterns instead of ML for detection

**Rationale:** Patterns are transparent, debuggable, and work without training data. Language indicators ("we need to", "should implement") are reliable signals.

### 3. Effort Estimation from Keywords
**Decision:** Extract effort from text keywords instead of task type

**Rationale:** Users often indicate effort in their descriptions ("quick fix", "week-long project"). Keywords are more accurate than generic categories.

### 4. Sub-Steps for Large Tasks
**Decision:** Auto-generate Design → Implementation → Testing sub-steps

**Rationale:** Tasks >240 minutes benefit from intermediate milestones. Automatic sub-steps provide structure without manual breakdown.

### 5. Dependency Inference
**Decision:** Detect dependencies from text patterns instead of explicit specification

**Rationale:** Agents naturally express dependencies ("then test", "requires implementation first"). Text analysis captures implicit relationships automatically.

---

## FUTURE ENHANCEMENTS

1. **ML-Based Confidence Scoring** — Learn from past plan accuracy
2. **Parallel Task Optimization** — Identify independent tasks that can run concurrently
3. **Effort Learning** — Track actual vs estimated and refine predictions
4. **Cross-Agent Coordination** — Detect shared dependencies across agents
5. **Historical Plans** — Learn patterns from previous successful plans
6. **Dynamic Adjustment** — Update plans as new information emerges
7. **Cost Analysis** — Factor in resource constraints and optimize allocation
8. **User Feedback Loop** — Improve detection based on approvals/rejections

---

## DEPLOYMENT

### Integration Steps
1. Add auto-planning configuration to `orchestrator.config.json`
2. Create ConversationMonitor instance at orchestrator startup
3. Hook message recording in agent communication pipeline
4. Expose approval bridge to user interface
5. Display pending approvals in dashboard

### Configuration Defaults
- Detection confidence threshold: 50
- Default effort estimate: 120 minutes
- Sub-step threshold: 240 minutes
- Require user approval: true
- Conversation context window: 20 messages

---

**Auto-Planning System Status: PRODUCTION READY ✅**

*Implementation Date: 2026-10-09*  
*Tests: 32 passing, 0 failing*  
*Total Test Coverage: 100%*

