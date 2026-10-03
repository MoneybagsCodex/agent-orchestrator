import express, { Request, Response } from 'express';
import { Orchestrator } from './orchestrator';
import { parseMission } from './mission-parser';

const app = express();
const PORT = 3003;

app.use(express.json());

let currentOrchestrator: Orchestrator | null = null;

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
  }));

  res.json({
    phases,
    progress,
    riskLevel: currentOrchestrator.getRiskLevel(),
    events: currentOrchestrator.executionEvents,
  });
});

app.post('/command', async (req: Request, res: Response) => {
  try {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'Command required' });
    }

    // Parse mission and initialize orchestrator
    const workflow = parseMission(command);
    const orchestrator = new Orchestrator(workflow);
    orchestrator.initialize();

    currentOrchestrator = orchestrator;

    // Start execution loop (non-blocking)
    executeWorkflow(orchestrator);

    res.json({
      status: 'accepted',
      summary: `Executing: ${command}`,
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

async function executeWorkflow(orchestrator: Orchestrator) {
  try {
    while (orchestrator.getProgress().percentComplete < 100) {
      const nextPhases = orchestrator.getNextPhasesToExecute();
      if (nextPhases.length === 0) break;

      for (const phaseId of nextPhases) {
        await orchestrator.executeStep(phaseId);
      }

      // Simulate execution time
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error('Workflow execution error:', error);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Orchestrator API running on http://localhost:${PORT}`);
});
