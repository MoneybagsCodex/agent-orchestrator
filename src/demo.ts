/**
 * Demo: orchestrate a full workflow end-to-end
 */

import { masterAgent } from './master-agent.js';
import { Orchestrator } from './orchestrator.js';

async function demo() {
  console.log('🚀 Agent Orchestrator Demo\n');
  console.log('='.repeat(60));

  // User input (voice or text)
  const userCommand = 'Deploy v2.1.0 to production';
  console.log(`📝 User Command: "${userCommand}"\n`);

  // Step 1: Master agent interprets intent
  console.log('Step 1: Master Agent Processing');
  console.log('-'.repeat(60));
  const masterAgentOutput = await masterAgent({
    type: 'text',
    content: userCommand,
  });

  console.log(`✓ Understood: ${masterAgentOutput.understood}`);
  console.log(`✓ Confidence: ${(masterAgentOutput.confidence * 100).toFixed(0)}%`);
  console.log(`✓ Intent: ${masterAgentOutput.intent}`);
  console.log(`✓ Summary: ${masterAgentOutput.summary}\n`);

  // Step 2: Orchestrator initializes workflow
  console.log('Step 2: Orchestrator Initialization');
  console.log('-'.repeat(60));
  const orchestrator = new Orchestrator(masterAgentOutput.workflow);
  orchestrator.initialize();

  console.log(`✓ Workflow parsed: ${masterAgentOutput.workflow.phases.length} phases`);
  console.log(`✓ Agent assignments ready\n`);

  // Print initial state
  printWorkflowState(orchestrator);

  // Step 3: Execute workflow
  console.log('\nStep 3: Workflow Execution');
  console.log('-'.repeat(60));

  let executionComplete = false;
  let iterations = 0;
  const maxIterations = 20;

  while (!executionComplete && iterations < maxIterations) {
    iterations++;

    // Get ready phases
    const { ready } = orchestrator.getNextPhasesToExecute();

    if (ready.length === 0) {
      executionComplete = true;
      console.log('\n✓ Workflow complete!\n');
      break;
    }

    // Execute ready phases
    for (const phase of ready) {
      console.log(`\n⏳ Executing: ${phase.description} (Agent ${phase.assignedAgent?.id})`);
      const result = orchestrator.executeStep(phase.id);

      if (result.success) {
        console.log(`   ✓ Success`);
        if (result.output) {
          console.log(`   Output: ${JSON.stringify(result.output)}`);
        }
      } else {
        console.log(`   ⚠️  Blocked - Manual approval required`);
        if (result.output) {
          console.log(`   Details: ${JSON.stringify(result.output)}`);
        }
      }
    }

    // Print current state
    printWorkflowState(orchestrator);

    // Small delay for readability
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('EXECUTION SUMMARY');
  console.log('='.repeat(60));
  const state = orchestrator.getExecutionState();
  console.log(`✓ Progress: ${state.progress.completed}/${state.progress.total} phases (${state.progress.percentComplete}%)`);
  console.log(`✓ Risk Level: ${state.riskLevel}`);
  console.log(`✓ Execution Events: ${state.log.length}\n`);

  // Print final phases
  console.log('Final Phase States:');
  for (const phase of state.phases) {
    const icon =
      phase.state === 'done'
        ? '✓'
        : phase.state === 'running'
          ? '⏳'
          : phase.state === 'blocked'
            ? '⚠️'
            : '⚫';
    console.log(`  ${icon} ${phase.description}: ${phase.state}`);
  }

  console.log('\n' + '='.repeat(60) + '\n');
}

function printWorkflowState(orchestrator: Orchestrator) {
  const state = orchestrator.getExecutionState();
  console.log(`\nCurrent Progress: ${state.progress.completed}/${state.progress.total} (${state.progress.percentComplete}%)`);
  console.log(`Risk Level: ${state.riskLevel}`);

  const { ready, parallel } = orchestrator.getNextPhasesToExecute();
  if (ready.length > 0) {
    console.log(`Ready to execute: ${ready.map((p) => p.description).join(', ')}`);
  } else {
    console.log('Awaiting approvals or workflow complete');
  }
}

// Run demo
demo().catch(console.error);
