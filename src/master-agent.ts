/**
 * Master Orchestration Agent
 * Interfaces with Claude API to interpret user intent and plan workflows
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseMission } from './mission-parser.js';
import { Orchestrator } from './orchestrator.js';
import type { MasterAgentInput, MasterAgentOutput, WorkflowDAG } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function masterAgent(input: MasterAgentInput): Promise<MasterAgentOutput> {
  const systemPrompt = `You are a master orchestration agent. Your role is to:
1. Understand user intent from voice or text commands
2. Plan a workflow to accomplish that intent
3. Decide which agents should do which work
4. Provide a clear summary of the plan

When a user says something like "Deploy v2.1.0", you should:
- Understand: they want to deploy a version
- Plan: test → analyze → security → approval → deploy
- Assign: Agent A does testing, Agent B does perf analysis, etc.
- Summarize: what you understood, what will happen, in human terms

Respond with JSON in this format:
{
  "understood": true,
  "confidence": 0.95,
  "intent": "deploy",
  "summary": "Deploy v2.1.0 to production: run tests, analyze performance, security scan, get approval, then deploy to staging with 24h monitoring"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 256,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `User said: "${input.content}"\n\nUnderstand their intent and provide your analysis in JSON format.`,
        },
      ],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as any).text)
      .join('');

    const parsed = JSON.parse(text);

    // Parse the mission to get workflow DAG
    const workflow = parseMission(input.content);

    return {
      understood: parsed.understood ?? true,
      confidence: parsed.confidence ?? 0.9,
      intent: parsed.intent || 'unknown',
      workflow,
      agentAssignments: new Map(),
      summary: parsed.summary || `Will execute: ${input.content}`,
    };
  } catch (error) {
    console.error('Master agent error:', error);

    // Fallback: parse locally without Claude
    const workflow = parseMission(input.content);
    return {
      understood: true,
      confidence: 0.7,
      intent: 'unknown',
      workflow,
      agentAssignments: new Map(),
      summary: `Will attempt to: ${input.content}`,
    };
  }
}
