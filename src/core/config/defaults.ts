import type { AgentConfig } from '../types/config.js';

export const DEFAULT_CONFIG: AgentConfig = {
  platform: { name: 'app', envVar: 'NODE_ENV' },
  sentry: { defaultOrg: '', projects: [] },
  services: {},
  conventions: { spanNames: {}, attributeKeys: {}, rules: [] },
  dependencies: {},
  traceFlow: [],
  sampling: { production: 0.1, staging: 1.0, development: 1.0, test: 0.0 },
  runbooks: {},
  diagnosisPatterns: [],
  knownBugs: [],
  metering: { outboxTable: 'openmeter_event_ledger', deadLetterThreshold: 10, queueDepthThreshold: 500 },
};
