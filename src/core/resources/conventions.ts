import type { AgentConfig } from '../types/config.js';

export function getConventionsData(config: AgentConfig) {
  return {
    services: config.services,
    spanNames: config.conventions.spanNames,
    attributeKeys: config.conventions.attributeKeys,
    rules: config.conventions.rules,
  };
}
