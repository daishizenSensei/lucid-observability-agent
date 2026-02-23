import { loadConfig } from './core/config/index.js';
import { createAllTools } from './core/tools/index.js';
import { registerAllCommands } from './core/commands/index.js';
import { toTypeBoxSchema } from './adapters/typebox-schema.js';
import { PLUGIN_NAME } from './core/plugin-id.js';

export default function register(api: any): void {
  const rawConfig = api.config ?? {};
  const config = loadConfig(rawConfig);

  const tools = createAllTools({ config });

  for (const tool of tools) {
    api.registerTool(tool.name, {
      description: tool.description,
      parameters: toTypeBoxSchema(tool.params),
      execute: tool.execute,
    });
  }

  registerAllCommands(api, { config, tools });

  process.stderr.write(`[${PLUGIN_NAME}] Registered ${tools.length} tools\n`);
}
