import type { AgentConfig } from '../types/config.js';
import type { ToolDefinition } from '../tools/types.js';
import { createObsStatusHandler } from './obs-status.js';
import { createObsCheckHandler } from './obs-check.js';

export interface CommandDependencies {
  config: AgentConfig;
  tools: ToolDefinition[];
}

export function registerAllCommands(api: any, deps: CommandDependencies): void {
  api.registerCommand({
    name: 'obs-status',
    description: 'Show observability agent status (config, services, connections)',
    handler: createObsStatusHandler({ config: deps.config }),
  });

  api.registerCommand({
    name: 'obs-check',
    description: 'Run observability health checks (config audit + outbox health)',
    handler: createObsCheckHandler({ config: deps.config, tools: deps.tools }),
  });
}
