import type { AgentConfig } from '../types/config.js';

const SENTRY_API = 'https://sentry.io/api/0';

export async function sentryFetch(
  config: AgentConfig,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<unknown> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error('SENTRY_AUTH_TOKEN env var not set');
  const org = process.env.SENTRY_ORG || config.sentry.defaultOrg;
  if (!org) throw new Error('SENTRY_ORG env var not set and no defaultOrg in config');

  const url = path.startsWith('/organizations/')
    ? `${SENTRY_API}${path}`
    : `${SENTRY_API}/organizations/${org}${path}`;

  const res = await fetch(url, {
    method: opts?.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`Sentry ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return res.json();
}
