import express, { Request, Response } from 'express';
import { Orchestrator } from './orchestrator';
import { parseMission } from './mission-parser';
import { Conversation } from './conversation';

const app = express();
const PORT = 3003;

app.use(express.json());

let currentOrchestrator: Orchestrator | null = null;
let executionResults: any[] = [];
let currentConversation: Conversation | null = null;

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', port: PORT });
});

app.get('/status', (req: Request, res: Response) => {
  if (!currentOrchestrator) {
    return res.status(400).json({ error: 'No active mission' });
  }

  const progress = currentOrchestrator.getProgress();
  const phases = currentOrchestrator.workflow.phases.map(p => ({
    id: p.id,
    description: p.description,
    state: p.state,
    assignedAgent: p.assignedAgent?.name,
    output: p.output,
  }));

  res.json({
    phases,
    progress,
    riskLevel: currentOrchestrator.getRiskLevel(),
    events: currentOrchestrator.executionEvents,
    results: executionResults,
  });
});

app.post('/command', async (req: Request, res: Response) => {
  try {
    const { command, model = 'claude-opus-5-5' } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'Command required' });
    }

    // Initialize conversation
    const conversation = new Conversation(model);
    const plan = await conversation.generateInitialPlan(command);

    // Parse mission and initialize orchestrator
    const workflow = parseMission(command);
    const orchestrator = new Orchestrator(workflow);
    orchestrator.initialize();

    currentOrchestrator = orchestrator;
    currentConversation = conversation;
    executionResults = [];

    // Start execution loop (non-blocking)
    executeWorkflow(orchestrator, command, conversation);

    res.json({
      status: 'planning',
      plan,
      workflow: {
        id: workflow.id,
        title: workflow.title,
        phaseCount: workflow.phases.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.post('/decision', async (req: Request, res: Response) => {
  try {
    const { decision } = req.body;
    if (!decision || !currentConversation) {
      return res.status(400).json({ error: 'Decision required or no active conversation' });
    }

    const response = await currentConversation.respondToUserDecision(decision);
    res.json({
      status: 'acknowledged',
      response,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/response', async (req: Request, res: Response) => {
  if (!currentOrchestrator) {
    return res.status(400).json({ error: 'No active mission' });
  }

  const progress = currentOrchestrator.getProgress();

  // If mission not complete, return current status
  if (progress.percentComplete < 100) {
    return res.json({
      status: 'executing',
      message: `Executing phases: ${progress.completed}/${progress.total} complete`,
      progress,
    });
  }

  // Mission complete - synthesize response from phase results
  try {
    const response = await synthesizeResponse(currentOrchestrator);
    res.json({
      status: 'complete',
      message: response,
      progress,
    });
  } catch (error) {
    res.json({
      status: 'complete',
      message: 'Mission executed successfully. All phases completed.',
      progress,
    });
  }
});

async function executeWorkflow(
  orchestrator: Orchestrator,
  originalCommand: string,
  conversation: Conversation
) {
  try {
    const startTime = Date.now();
    let phaseCheckpoint = 0;

    while (orchestrator.getProgress().percentComplete < 100) {
      const nextPhases = orchestrator.getNextPhasesToExecute();
      if (nextPhases.length === 0) break;

      for (const phaseId of nextPhases) {
        await orchestrator.executeStep(phaseId);
      }

      // After every 2-3 phases, synthesize interim results
      const completedCount = orchestrator.workflow.phases.filter(p => p.state === 'done').length;
      if (completedCount >= phaseCheckpoint + 2 || completedCount === orchestrator.workflow.phases.length) {
        const completedPhases = orchestrator.workflow.phases.filter(p => p.state === 'done');
        await conversation.synthesizePhaseResults(
          completedPhases,
          completedPhases.map(p => ({
            name: p.description,
            agent: p.assignedAgent?.name,
            output: p.output,
          })),
          orchestrator.getRiskLevel()
        );
        phaseCheckpoint = completedCount;
      }

      // Simulate execution time
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const duration = Date.now() - startTime;

    // Store execution summary
    executionResults.push({
      command: originalCommand,
      duration,
      timestamp: new Date().toISOString(),
      phaseResults: orchestrator.workflow.phases.map(p => ({
        name: p.description,
        agent: p.assignedAgent?.name,
        state: p.state,
        output: p.output,
      })),
    });
  } catch (error) {
    console.error('Workflow execution error:', error);
  }
}

async function synthesizeResponse(orchestrator: Orchestrator): Promise<string> {
  const phaseData = orchestrator.workflow.phases.map(p => ({
    description: p.description,
    agent: p.assignedAgent?.name,
    state: p.state,
    output: p.output,
  }));

  try {
    const prompt = `You are a master orchestration agent. Synthesize the results of a multi-agent workflow execution into a concise, actionable response.

Phases executed:
${JSON.stringify(phaseData, null, 2)}

Risk level: ${orchestrator.getRiskLevel()}

Provide a brief summary (2-3 sentences) of what happened, any concerns, and what's next. Be conversational and start with an action word.`;

    const message = await client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0];
    if (content.type === 'text') {
      return content.text;
    }
  } catch (error) {
    console.error('Claude API error:', error);
  }

  // Fallback: synthesize from phase data
  const completedPhases = phaseData.filter(p => p.state === 'done').length;
  const riskLevel = orchestrator.getRiskLevel();
  const riskEmoji = riskLevel === 'low' ? '🟢' : riskLevel === 'medium' ? '🟡' : '🔴';

  return `✓ All ${phaseData.length} phases executed successfully. Risk level: ${riskEmoji} ${riskLevel}. Deployment ready for review.`;
}

app.listen(PORT, () => {
  console.log(`🚀 Orchestrator API running on http://localhost:${PORT}`);
});
