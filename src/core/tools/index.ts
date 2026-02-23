import type { ToolDefinition } from './types.js';
import type { AgentConfig } from '../types/config.js';
import { createSentryListIssuesTool, createSentryGetIssueTool, createSentryGetIssueEventsTool, createSentryResolveIssueTool, createSentrySearchByTraceTool, createSentryProjectStatsTool } from './sentry.js';
import { createDiagnoseIssueTool, createCrossCorrelateTool } from './diagnosis.js';
import { createOutboxHealthTool, createUsageByOrgTool, createDeadLetterRetryTool, createUsageAnomalyTool } from './openmeter.js';
import { createCheckConfigHealthTool, createCheckConventionsTool } from './config-health.js';
import { createSuggestAlertRulesTool, createGenerateRunbookTool } from './autofix.js';

export interface ToolDependencies {
  config: AgentConfig;
}

export function createAllTools(deps: ToolDependencies): ToolDefinition[] {
  return [
    createSentryListIssuesTool(deps),
    createSentryGetIssueTool(deps),
    createSentryGetIssueEventsTool(deps),
    createSentryResolveIssueTool(deps),
    createSentrySearchByTraceTool(deps),
    createSentryProjectStatsTool(deps),
    createDiagnoseIssueTool(deps),
    createCrossCorrelateTool(deps),
    createOutboxHealthTool(deps),
    createUsageByOrgTool(deps),
    createDeadLetterRetryTool(deps),
    createUsageAnomalyTool(deps),
    createCheckConfigHealthTool(deps),
    createCheckConventionsTool(deps),
    createSuggestAlertRulesTool(deps),
    createGenerateRunbookTool(deps),
  ];
}

export type { ToolDefinition, ToolParamDef } from './types.js';
