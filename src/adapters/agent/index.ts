import type { AgentConfig } from '../../config/schema.ts';
import { ClaudeCodeAgent } from './claude-code.ts';
import { StdioAgent } from './stdio.ts';
import type { AgentAdapter } from './types.ts';
import { WebhookAgent } from './webhook.ts';

export function createAgent(name: string, cfg: AgentConfig): AgentAdapter {
  switch (cfg.type) {
    case 'claude-code':
      return new ClaudeCodeAgent(name, cfg);
    case 'webhook':
      return new WebhookAgent(name, cfg);
    case 'stdio':
      return new StdioAgent(name, cfg);
  }
}
