/**
 * Conversation management for master agent dialogue
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Orchestrator } from './orchestrator';

const client = new Anthropic();

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export class Conversation {
  private messages: ConversationMessage[] = [];
  private model: string = 'claude-opus-5-5';

  constructor(model: string = 'claude-opus-5-5') {
    this.model = model;
  }

  setModel(model: string) {
    this.model = model;
  }

  addMessage(role: 'user' | 'assistant', content: string) {
    this.messages.push({ role, content, timestamp: new Date() });
  }

  getHistory() {
    return this.messages.map(m => ({ role: m.role, content: m.content }));
  }

  async generateInitialPlan(command: string): Promise<string> {
    this.addMessage('user', command);

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 512,
        system: `You are a master orchestration agent controlling 6 specialized sub-agents:
- Agent A: Testing (runs comprehensive tests)
- Agent B: Performance Analysis
- Agent C: Security Audits
- Agent D: Integration Testing
- Agent E: Approval & Risk Assessment
- Agent F: Deployment & Monitoring

Your job is to interpret user commands and orchestrate these agents to execute workflows.
Be concise and action-oriented. Explain your plan clearly.`,
        messages: this.getHistory(),
      });

      const content = response.content[0];
      if (content.type === 'text') {
        this.addMessage('assistant', content.text);
        return content.text;
      }
    } catch (error) {
      // Fallback if API key not available
      return this.generateFallbackPlan(command);
    }

    return 'Error generating plan';
  }

  private generateFallbackPlan(command: string): string {
    const plan = `I'll orchestrate this deployment for you:

1. **Testing Phase**: Running comprehensive tests with Agent A (QA)
2. **Parallel Analysis**: Security audit (Agent C) + Performance analysis (Agent B)
3. **Integration**: Running integration tests with Agent D
4. **Approval**: Risk assessment by Agent E
5. **Deployment**: Rolling out to production with Agent F
6. **Monitoring**: 24h monitoring by Agent E

Starting execution now...`;

    this.addMessage('assistant', plan);
    return plan;
  }

  async synthesizePhaseResults(
    phases: any[],
    phaseResults: any[],
    riskLevel: string
  ): Promise<string> {
    const phaseSummary = phaseResults
      .map(
        (r: any) =>
          `${r.name} (${r.agent}): ${r.output?.allPassed ? '✓ passed' : r.output?.passed ? '✓ passed' : '⚠️ issues'}`
      )
      .join(', ');

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 256,
        system: `You are reporting phase execution status to the user. Be concise and clear about:
1. What completed
2. Any issues or risks detected
3. What's next (continue or ask for decision)
4. If asking for a decision, be specific: "Should I proceed with X?"`,
        messages: [
          { role: 'user', content: `Phases completed so far: ${phaseSummary}. Risk level: ${riskLevel}. What's the status and next steps?` },
        ],
      });

      const content = response.content[0];
      if (content.type === 'text') {
        this.addMessage('assistant', content.text);
        return content.text;
      }
    } catch (error) {
      // Fallback synthesis
      const riskEmoji = riskLevel === 'low' ? '🟢' : riskLevel === 'medium' ? '🟡' : '🔴';
      const fallback = `${riskEmoji} **Status Update**: ${phaseSummary}. Risk level: ${riskLevel}. Continuing with deployment sequence...`;
      this.addMessage('assistant', fallback);
      return fallback;
    }

    return 'Status update unavailable';
  }

  async respondToUserDecision(userDecision: string): Promise<string> {
    this.addMessage('user', userDecision);

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 256,
        system: `You are the master orchestration agent. The user just made a decision about the workflow.
Acknowledge their decision and explain what you'll do next. Be concise and clear.`,
        messages: this.getHistory(),
      });

      const content = response.content[0];
      if (content.type === 'text') {
        this.addMessage('assistant', content.text);
        return content.text;
      }
    } catch (error) {
      // Fallback response
      const fallback = `✓ Got it. Proceeding with your decision. Resuming execution...`;
      this.addMessage('assistant', fallback);
      return fallback;
    }

    return 'Error processing decision';
  }
}
