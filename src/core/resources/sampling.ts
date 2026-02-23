import type { AgentConfig } from '../types/config.js';

export function getSamplingData(config: AgentConfig) {
  return {
    headSampling: config.sampling,
    tailSampling: {
      description: 'Configure at collector level (Grafana Tempo, Honeycomb)',
      rules: [
        'Keep 100% of traces containing error spans',
        'Keep 100% of traces with latency > p99',
        'Keep 100% of traces with span.status = ERROR',
      ],
    },
    override: 'Set OTEL_TRACES_SAMPLER_ARG env var to override head sampling ratio',
  };
}
