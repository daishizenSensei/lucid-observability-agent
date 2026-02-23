import type { AgentConfig } from '../types/config.js';

export function createObsStatusHandler(deps: { config: AgentConfig }) {
  return async (): Promise<string> => {
    const { config } = deps;
    const lines: string[] = [
      '## Observability Agent Status',
      '',
      `**Platform:** ${config.platform.name}`,
      `**Sentry Org:** ${process.env.SENTRY_ORG || config.sentry.defaultOrg || 'not configured'}`,
      `**Sentry Projects:** ${config.sentry.projects.join(', ') || 'none'}`,
      `**Services:** ${Object.keys(config.services).join(', ') || 'none'}`,
      `**Database:** ${process.env.DATABASE_URL ? 'configured' : 'not configured'}`,
      `**Sentry Auth:** ${process.env.SENTRY_AUTH_TOKEN ? 'configured' : 'not configured'}`,
      `**Diagnosis Patterns:** ${config.diagnosisPatterns.length}`,
      `**Known Bugs:** ${config.knownBugs.length}`,
      `**Runbook Categories:** ${Object.keys(config.runbooks).length}`,
    ];
    return lines.join('\n');
  };
}
