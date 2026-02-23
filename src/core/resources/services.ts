import type { AgentConfig } from '../types/config.js';

export function getServicesData(config: AgentConfig) {
  return {
    services: config.services,
    dependencies: config.dependencies,
    traceFlow: config.traceFlow,
  };
}
