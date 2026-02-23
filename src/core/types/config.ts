export interface ServiceInfo {
  repo: string;
  runtime: string;
  framework: string;
  sentryProject: string;
}

export interface AttributeKeyInfo {
  description: string;
  pii: boolean;
  highCardinality: boolean;
}

export interface RunbookPhase {
  title: string;
  severity: string;
  triage: string[];
  diagnose: string[];
  mitigate: string[];
  resolve: string[];
  postmortem: string[];
}

export interface DiagnosisPattern {
  category: string;
  keywords: string[];
  rootCause: string;
  suggestions: Array<{ action: string; description: string; confidence: 'high' | 'medium' | 'low'; command?: string }>;
  relatedPatterns: string[];
}

export interface KnownBug {
  id: string;
  title: string;
  keywords: string[];
  description: string;
  fix: string;
  fixed: boolean;
}

export interface AgentConfig {
  platform: { name: string; envVar: string };
  sentry: { defaultOrg: string; projects: string[] };
  services: Record<string, ServiceInfo>;
  conventions: {
    spanNames: Record<string, string>;
    attributeKeys: Record<string, AttributeKeyInfo>;
    rules: string[];
  };
  dependencies: Record<string, string[]>;
  traceFlow: string[];
  sampling: Record<string, number>;
  runbooks: Record<string, RunbookPhase>;
  diagnosisPatterns: DiagnosisPattern[];
  knownBugs: KnownBug[];
  metering: {
    outboxTable: string;
    deadLetterThreshold: number;
    queueDepthThreshold: number;
  };
}
