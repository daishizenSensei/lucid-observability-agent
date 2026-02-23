import type { AgentConfig } from '../types/config.js';
import type { ToolDefinition } from '../tools/types.js';

export function createObsCheckHandler(deps: { config: AgentConfig; tools: ToolDefinition[] }) {
  return async (): Promise<string> => {
    const results: string[] = ['## Observability Health Check\n'];
    const toolNames = ['check_config_health', 'openmeter_outbox_health'];

    for (const name of toolNames) {
      const tool = deps.tools.find(t => t.name === name);
      if (!tool) { results.push(`**${name}:** skipped (tool not found)`); continue; }

      try {
        const defaultArgs = name === 'check_config_health' ? { environment: 'production' } : { hours: 24 };
        const output = await tool.execute(defaultArgs);
        results.push(`### ${name}\n\`\`\`json\n${output}\n\`\`\`\n`);
      } catch (e) {
        results.push(`### ${name}\nError: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    return results.join('\n');
  };
}
