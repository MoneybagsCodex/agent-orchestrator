> **Setup and running:** see [SETUP.md](SETUP.md). The demo below is the original prototype and is out of date.

# Agent Orchestrator — Demo

Master orchestration agent + workflow engine for coordinating multiple Claude agents.

## What This Does

1. **Accepts user input** (voice or text): "Deploy v2.1.0"
2. **Master agent interprets** intent via Claude API
3. **Parses into workflow**: test → analyze → security → approve → deploy
4. **Auto-assigns agents**: Agent A does testing, B does perf analysis, etc.
5. **Executes workflow**: Runs phases in order, handles dependencies, parallelizes
6. **Makes decisions**: Evaluates conditions (if test passes → continue, etc.)
7. **Shows progress**: Real-time visualization of what's happening

## Quick Start

```bash
npm install
ANTHROPIC_API_KEY=sk-... npm run demo
```

Output:
```
🚀 Agent Orchestrator Demo

📝 User Command: "Deploy v2.1.0 to production"

Step 1: Master Agent Processing
✓ Understood: true
✓ Confidence: 95%
✓ Intent: deploy
✓ Summary: Deploy v2.1.0 to production: run tests, analyze performance...

Step 2: Orchestrator Initialization
✓ Workflow parsed: 7 phases
✓ Agent assignments ready

[Shows phase execution with real-time updates]

Step 3: Workflow Execution
⏳ Executing: Run comprehensive test suite (Agent A)
   ✓ Success
   Output: {"testsRun":147,"passed":145,"failed":2,"coverage":87}

Current Progress: 1/7 (14%)
Risk Level: low
Ready to execute: Analyze performance impact, Run security audit
```

## Architecture

```
User Input (voice/text)
    ↓
Master Agent (Claude API)
  - Interprets intent
  - Plans workflow
    ↓
Mission Parser
  - Converts to WorkflowDAG
    ↓
Orchestrator
  - Assigns agents
  - Manages execution
  - Evaluates conditions
  - Tracks state
    ↓
Output: Workflow execution log
```

## Components

- **types.ts** — Core type definitions
- **agent-registry.ts** — Agent capabilities registry
- **mission-parser.ts** — Converts mission to workflow DAG
- **router.ts** — Assigns agents to tasks
- **state-machine.ts** — Tracks phase execution states
- **orchestrator.ts** — Main execution engine
- **master-agent.ts** — Claude API wrapper for intent understanding
- **demo.ts** — End-to-end demo

## Features

✓ Parse natural language missions  
✓ Auto-assign agents based on capability matching  
✓ Build dependency graphs  
✓ Execute workflows with proper sequencing  
✓ Parallelize independent phases  
✓ Evaluate conditional logic  
✓ Track risk levels  
✓ Real-time progress updates  
✓ Execution logging  

## Next Steps (Future)

- [ ] Integrate with cockpit dashboard
- [ ] Add voice/text input UI
- [ ] Connect to real bridge agents
- [ ] Persist execution history
- [ ] Add approval gates
- [ ] Implement rollback logic
- [ ] Add metrics & monitoring
