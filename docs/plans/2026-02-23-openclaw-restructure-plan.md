# OpenClaw Dual Entry Point Restructure — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure lucid-observability-agent from a pure MCP server into a dual MCP + OpenClaw plugin following the Lucid-Veille pattern.

**Architecture:** Single codebase with framework-agnostic core (`src/core/`), generic `ToolParamDef` tool definitions, Zod/TypeBox schema adapters, and thin entry points for MCP (`src/mcp.ts`) and OpenClaw (`src/openclaw.ts`). Removes all hardcoded autonomous logic (webhook, scheduler, auto-resolve) in favor of OpenClaw heartbeat-driven AI reasoning.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, @sinclair/typebox, zod, pg, tsup

**Design Doc:** `docs/plans/2026-02-23-openclaw-restructure-design.md`

**Reference Implementation:** `C:\Lucid-Veille` (same dual entry point pattern)

---

### Task 1: Install new dependencies and configure tsup

**Files:**
- Modify: `package.json`
- Create: `tsup.config.ts`
- Modify: `tsconfig.json`

**Step 1: Install tsup and typebox**

Run: `cd /c/lucid-observability-agent && npm install --save @sinclair/typebox && npm install --save-dev tsup`

**Step 2: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp.ts', 'src/openclaw.ts', 'src/bin.ts', 'src/core/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  outDir: 'dist',
});
```

**Step 3: Update package.json**

Change version to `3.0.0`. Replace scripts, exports, bin:

```json
{
  "version": "3.0.0",
  "main": "dist/index.js",
  "bin": {
    "lucid-obs-agent": "dist/bin.js"
  },
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./mcp": { "import": "./dist/mcp.js", "types": "./dist/mcp.d.ts" },
    "./core": { "import": "./dist/core/index.js", "types": "./dist/core/index.d.ts" }
  },
  "openclaw": { "extensions": ["./src/index.ts"] },
  "scripts": {
    "build": "tsup",
    "start": "node dist/bin.js",
    "dev": "npx tsx src/bin.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

Remove old `start:service`, `dev:service` scripts. Keep dependencies: `@modelcontextprotocol/sdk`, `pg`, `zod`. Add `@sinclair/typebox`. Add `tsup` to devDependencies.

**Step 4: Update tsconfig.json**

Set `"noEmit": true` since tsup handles the build. Remove `"outDir": "dist"` and `"declaration": true` (tsup manages these). Keep `"strict": true`, `"module": "Node16"`, `"target": "ES2022"`.

**Step 5: Commit**

```bash
git add package.json tsup.config.ts tsconfig.json package-lock.json
git commit -m "chore: add tsup build, typebox dep, update package exports for dual entry"
```

---

### Task 2: Create core foundation files

**Files:**
- Create: `src/core/plugin-id.ts`
- Create: `src/core/tools/types.ts`
- Create: `src/adapters/zod-schema.ts`
- Create: `src/adapters/typebox-schema.ts`

**Step 1: Create src/core/plugin-id.ts**

```typescript
export const PLUGIN_ID = 'lucid-observability';
export const PLUGIN_NAME = 'Lucid Observability Agent';
export const PLUGIN_VERSION = '3.0.0';
```

**Step 2: Create src/core/tools/types.ts**

```typescript
export type ParamType = 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array';

export interface ToolParamDef {
  type: ParamType;
  required?: boolean;
  description?: string;
  values?: string[];
  min?: number;
  max?: number;
  default?: unknown;
  properties?: Record<string, ToolParamDef>;
  items?: ToolParamDef;
}

export interface ToolDefinition<T = any> {
  name: string;
  description: string;
  params: Record<string, ToolParamDef>;
  execute: (params: T) => Promise<string>;
}
```

**Step 3: Create src/adapters/zod-schema.ts**

```typescript
import { z } from 'zod';
import type { ToolParamDef } from '../core/tools/types.js';

function paramToZod(def: ToolParamDef): z.ZodType {
  let schema: z.ZodType;

  switch (def.type) {
    case 'string':
      schema = z.string();
      break;
    case 'number': {
      let num = z.number();
      if (def.min !== undefined) num = num.min(def.min);
      if (def.max !== undefined) num = num.max(def.max);
      schema = num;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'enum':
      schema = z.enum(def.values as [string, ...string[]]);
      break;
    case 'object':
      if (def.properties) {
        schema = toZodSchema(def.properties);
      } else {
        schema = z.record(z.string(), z.unknown());
      }
      break;
    case 'array':
      schema = z.array(def.items ? paramToZod(def.items) : z.unknown());
      break;
    default:
      schema = z.unknown();
  }

  if (def.description) {
    schema = schema.describe(def.description);
  }

  return schema;
}

export function toZodSchema(params: Record<string, ToolParamDef>): z.ZodObject<any> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, def] of Object.entries(params)) {
    let fieldSchema = paramToZod(def);
    if (def.default !== undefined) {
      fieldSchema = (fieldSchema as any).default(def.default);
    }
    shape[key] = def.required === false ? fieldSchema.optional() : fieldSchema;
  }
  return z.object(shape);
}
```

**Step 4: Create src/adapters/typebox-schema.ts**

```typescript
import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { ToolParamDef } from '../core/tools/types.js';

function paramToTypeBox(def: ToolParamDef): TSchema {
  switch (def.type) {
    case 'string':
      return Type.String(def.description ? { description: def.description } : {});
    case 'number': {
      const opts: Record<string, unknown> = {};
      if (def.description) opts.description = def.description;
      if (def.min !== undefined) opts.minimum = def.min;
      if (def.max !== undefined) opts.maximum = def.max;
      return Type.Number(opts);
    }
    case 'boolean':
      return Type.Boolean(def.description ? { description: def.description } : {});
    case 'enum':
      return Type.Union(
        (def.values ?? []).map((v) => Type.Literal(v)),
        def.description ? { description: def.description } : {},
      );
    case 'object':
      if (def.properties) {
        return toTypeBoxSchema(def.properties);
      }
      return Type.Record(Type.String(), Type.Unknown());
    case 'array':
      return Type.Array(def.items ? paramToTypeBox(def.items) : Type.Unknown());
    default:
      return Type.Unknown();
  }
}

export function toTypeBoxSchema(params: Record<string, ToolParamDef>): TObject {
  const properties: Record<string, TSchema> = {};
  for (const [key, def] of Object.entries(params)) {
    const fieldSchema = paramToTypeBox(def);
    properties[key] = def.required === false ? Type.Optional(fieldSchema) : fieldSchema;
  }
  return Type.Object(properties, { additionalProperties: false });
}
```

**Step 5: Verify types compile**

Run: `npx tsc --noEmit --strict src/core/tools/types.ts src/adapters/zod-schema.ts src/adapters/typebox-schema.ts`

(May need to skip this and do a full typecheck later once all imports resolve.)

**Step 6: Commit**

```bash
git add src/core/plugin-id.ts src/core/tools/types.ts src/adapters/
git commit -m "feat: add ToolParamDef types and Zod/TypeBox schema adapters"
```

---

### Task 3: Move helpers to core/helpers/

**Files:**
- Create: `src/core/helpers/sentry.ts`
- Create: `src/core/helpers/postgres.ts`
- Create: `src/core/helpers/response.ts`
- Create: `src/core/helpers/temporal.ts`

Split the monolithic `src/helpers.ts` into 4 focused modules under `src/core/helpers/`.

**Step 1: Create src/core/helpers/sentry.ts**

Move `sentryFetch()` and `resolveIssue()`. Change import of `AgentConfig` to `../types/config.js`.

```typescript
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

export async function resolveIssue(
  config: AgentConfig,
  issueId: string,
  action: 'resolve' | 'ignore' = 'resolve',
  ignoreDuration?: number,
): Promise<{ success: boolean; action: string; issueId: string }> {
  let body: Record<string, unknown>;
  if (action === 'resolve') body = { status: 'resolved' };
  else body = ignoreDuration
    ? { status: 'ignored', statusDetails: { ignoreDuration } }
    : { status: 'ignored' };

  await sentryFetch(config, `/issues/${issueId}/`, { method: 'PUT', body });
  return { success: true, action, issueId };
}
```

**Step 2: Create src/core/helpers/postgres.ts**

```typescript
type PgPool = import('pg').Pool;
let _pgPool: PgPool | null = null;

export async function getPgPool(): Promise<PgPool> {
  if (_pgPool) return _pgPool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL env var not set');
  const { Pool } = await import('pg');
  _pgPool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30_000 });
  return _pgPool;
}
```

**Step 3: Create src/core/helpers/response.ts**

These return plain strings now (not MCP content objects). The MCP wrapper in `mcp.ts` handles the `{ content: [...] }` envelope.

```typescript
export function ok(text: string): string {
  return text;
}

export function err(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `Error: ${msg}`;
}

export function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
```

**Step 4: Create src/core/helpers/temporal.ts**

Move `extractStacktrace()`, `extractBreadcrumbs()`, `detectTemporalPattern()` — unchanged except no imports needed.

```typescript
export function extractStacktrace(event: Record<string, unknown>): string[] {
  const frames: string[] = [];
  const entries = (event.entries || []) as Array<Record<string, unknown>>;

  for (const entry of entries) {
    if (entry.type === 'exception') {
      const values = ((entry.data as Record<string, unknown>)?.values || []) as Array<Record<string, unknown>>;
      for (const exc of values) {
        frames.push(`${exc.type}: ${exc.value}`);
        const st = exc.stacktrace as Record<string, unknown> | undefined;
        if (st?.frames) {
          const stFrames = st.frames as Array<Record<string, unknown>>;
          for (const frame of stFrames.slice(-15)) {
            const filename = frame.filename || frame.absPath || 'unknown';
            const lineNo = frame.lineNo || '?';
            const colNo = frame.colNo ? `:${frame.colNo}` : '';
            const func = frame.function || '<anonymous>';
            const inApp = frame.inApp ? ' [app]' : '';
            frames.push(`  at ${func} (${filename}:${lineNo}${colNo})${inApp}`);
          }
        }
      }
    }
  }

  return frames;
}

export function extractBreadcrumbs(event: Record<string, unknown>): Array<{ timestamp: string; category: string; message: string }> {
  const entries = (event.entries || []) as Array<Record<string, unknown>>;
  for (const entry of entries) {
    if (entry.type === 'breadcrumbs') {
      const values = ((entry.data as Record<string, unknown>)?.values || []) as Array<Record<string, unknown>>;
      return values.slice(-10).map(b => ({
        timestamp: String(b.timestamp || ''),
        category: String(b.category || ''),
        message: String(b.message || b.data || ''),
      }));
    }
  }
  return [];
}

export function detectTemporalPattern(timestamps: string[]): {
  pattern: 'burst' | 'steady' | 'regression' | 'sporadic' | 'unknown';
  description: string;
} {
  if (timestamps.length < 2) return { pattern: 'unknown', description: 'Not enough events to detect pattern' };

  const times = timestamps.map(t => new Date(t).getTime()).sort((a, b) => b - a);
  const gaps = times.slice(0, -1).map((t, i) => t - times[i + 1]);

  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length;

  const spanMs = times[0] - times[times.length - 1];
  const spanHours = spanMs / (1000 * 60 * 60);

  const twentyPctMark = times[times.length - 1] + spanMs * 0.2;
  const eventsInFirst20Pct = times.filter(t => t <= twentyPctMark).length;
  if (eventsInFirst20Pct / times.length > 0.8 && spanHours > 1) {
    return { pattern: 'burst', description: `Burst: ${eventsInFirst20Pct} of ${times.length} events in a concentrated window` };
  }

  const cv = Math.sqrt(variance) / avgGap;
  if (cv < 0.5 && times.length >= 5) {
    return { pattern: 'steady', description: `Steady: ~${Math.round(avgGap / 1000)}s between events (CV=${cv.toFixed(2)})` };
  }

  const maxGap = Math.max(...gaps);
  if (maxGap > avgGap * 5 && times.length >= 3) {
    return { pattern: 'regression', description: `Regression: long gap of ${Math.round(maxGap / 1000 / 60)}min then new cluster` };
  }

  return { pattern: 'sporadic', description: `Sporadic: ${times.length} events over ${spanHours.toFixed(1)}h with irregular intervals` };
}
```

**Step 5: Commit**

```bash
git add src/core/helpers/
git commit -m "refactor: split helpers into core/helpers/ modules"
```

---

### Task 4: Move config to core/config/ and core/types/

**Files:**
- Create: `src/core/types/config.ts`
- Create: `src/core/config/defaults.ts`
- Create: `src/core/config/loader.ts`
- Create: `src/core/config/index.ts`

**Step 1: Create src/core/types/config.ts**

Move all interfaces from `src/config.ts`. Remove `WebhookConfig` and `PeriodicChecksConfig` (deleted features). Remove `webhook` and `periodicChecks` from `AgentConfig`.

```typescript
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
```

**Step 2: Create src/core/config/defaults.ts**

```typescript
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
```

**Step 3: Create src/core/config/loader.ts**

Same logic as current `src/config.ts` loader but imports from new locations. Accepts optional raw config object (for OpenClaw `api.config`).

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from '../types/config.js';
import { DEFAULT_CONFIG } from './defaults.js';

let _config: AgentConfig | null = null;

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const bVal = base[key];
    const oVal = override[key];
    if (bVal && oVal && typeof bVal === 'object' && typeof oVal === 'object' && !Array.isArray(bVal) && !Array.isArray(oVal)) {
      result[key] = deepMerge(bVal as Record<string, unknown>, oVal as Record<string, unknown>);
    } else {
      result[key] = oVal;
    }
  }
  return result;
}

function tryLoadJson(path: string): Record<string, unknown> | null {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    }
  } catch (e) {
    process.stderr.write(`[config] Failed to load ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return null;
}

export function loadConfig(raw?: Record<string, unknown>): AgentConfig {
  if (_config) return _config;

  let merged: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>;

  // Try loading default config relative to package root
  const thisDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(thisDir, '..', '..', '..');
  const defaultConfigPath = resolve(packageRoot, 'config', 'lucid.json');
  const defaultJson = tryLoadJson(defaultConfigPath);
  if (defaultJson) {
    merged = deepMerge(merged, defaultJson);
  }

  // Override with custom config file if specified
  const customPath = raw?.configPath as string | undefined ?? process.env.AGENT_CONFIG_PATH;
  if (customPath) {
    const customJson = tryLoadJson(resolve(customPath));
    if (customJson) {
      merged = deepMerge(merged, customJson);
    }
  }

  // Override with raw config values (from OpenClaw api.config)
  if (raw) {
    if (raw.sentryAuthToken && !process.env.SENTRY_AUTH_TOKEN) {
      process.env.SENTRY_AUTH_TOKEN = raw.sentryAuthToken as string;
    }
    if (raw.sentryOrg && !process.env.SENTRY_ORG) {
      process.env.SENTRY_ORG = raw.sentryOrg as string;
    }
    if (raw.databaseUrl && !process.env.DATABASE_URL) {
      process.env.DATABASE_URL = raw.databaseUrl as string;
    }
  }

  _config = merged as unknown as AgentConfig;
  return _config;
}

export function getConfig(): AgentConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
```

**Step 4: Create src/core/config/index.ts**

```typescript
export { loadConfig, getConfig, resetConfig } from './loader.js';
export { DEFAULT_CONFIG } from './defaults.js';
```

**Step 5: Commit**

```bash
git add src/core/types/ src/core/config/
git commit -m "refactor: move config types and loader to core/types/ and core/config/"
```

---

### Task 5: Convert Sentry tools (6) to ToolParamDef format

**Files:**
- Create: `src/core/tools/sentry.ts`

**Step 1: Write src/core/tools/sentry.ts**

Convert all 6 tools. Each tool is a factory function returning `ToolDefinition`. Key changes:
- Zod schemas → `ToolParamDef` objects
- `server.tool()` calls → factory functions returning `{ name, description, params, execute }`
- Return `string` instead of MCP content objects
- Import helpers from `../helpers/` instead of `../helpers.js`

```typescript
import type { ToolDefinition } from './types.js';
import type { AgentConfig } from '../types/config.js';
import { sentryFetch } from '../helpers/sentry.js';
import { extractStacktrace, extractBreadcrumbs, detectTemporalPattern } from '../helpers/temporal.js';
import { json, err } from '../helpers/response.js';

interface SentryToolDeps {
  config: AgentConfig;
}

export function createSentryListIssuesTool(deps: SentryToolDeps): ToolDefinition {
  const { config } = deps;
  const projects = config.sentry.projects;

  return {
    name: 'sentry_list_issues',
    description: 'List recent Sentry issues for a project. Supports Sentry search syntax.',
    params: {
      project: projects.length > 0
        ? { type: 'enum', values: projects, description: 'Sentry project slug' }
        : { type: 'string', description: 'Sentry project slug' },
      query: { type: 'string', default: 'is:unresolved', description: 'Sentry search query', required: false },
      limit: { type: 'number', min: 1, max: 100, default: 25, required: false },
      sort: { type: 'enum', values: ['date', 'new', 'freq', 'priority'], default: 'priority', required: false },
    },
    execute: async ({ project, query = 'is:unresolved', limit = 25, sort = 'priority' }) => {
      try {
        const issues = await sentryFetch(config,
          `/issues/?project=${project}&query=${encodeURIComponent(query)}&limit=${limit}&sort=${sort}`
        );
        if (!Array.isArray(issues)) return json(issues);

        const summary = issues.map((i: Record<string, unknown>) => ({
          id: i.id, shortId: i.shortId, title: i.title, culprit: i.culprit,
          level: i.level, count: i.count, userCount: i.userCount,
          firstSeen: i.firstSeen, lastSeen: i.lastSeen,
          status: i.status, isRegression: i.isRegression, priority: i.priority,
          assignedTo: (i.assignedTo as Record<string, unknown>)?.name || null,
        }));

        return json({ total: summary.length, issues: summary });
      } catch (e) { return err(e); }
    },
  };
}

export function createSentryGetIssueTool(deps: SentryToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_get_issue',
    description: 'Get full Sentry issue detail with latest event stack trace, tags, contexts, and cross-links.',
    params: {
      issueId: { type: 'string', description: 'Sentry issue ID' },
    },
    execute: async ({ issueId }) => {
      try {
        const [issue, latestEvent] = await Promise.all([
          sentryFetch(config, `/issues/${issueId}/`) as Promise<Record<string, unknown>>,
          sentryFetch(config, `/issues/${issueId}/events/latest/`) as Promise<Record<string, unknown>>,
        ]);

        const stacktrace = extractStacktrace(latestEvent);
        const tags = (latestEvent.tags || []) as Array<{ key: string; value: string }>;
        const contexts = (latestEvent.contexts || {}) as Record<string, unknown>;
        const breadcrumbs = extractBreadcrumbs(latestEvent);

        return json({
          issue: {
            id: issue.id, shortId: issue.shortId, title: issue.title,
            culprit: issue.culprit, level: issue.level,
            count: issue.count, userCount: issue.userCount,
            firstSeen: issue.firstSeen, lastSeen: issue.lastSeen,
            status: issue.status, substatus: issue.substatus,
            isRegression: issue.isRegression, priority: issue.priority,
            project: (issue.project as Record<string, unknown>)?.slug,
          },
          latestEvent: {
            eventId: latestEvent.eventID,
            message: latestEvent.message || latestEvent.title,
            stacktrace, breadcrumbs,
            tags: Object.fromEntries(tags.map(t => [t.key, t.value])),
            otelContext: contexts.otel || null,
            runtime: contexts.runtime || null,
          },
          crossLinks: {
            traceId: tags.find(t => t.key === 'trace_id')?.value || null,
            runId: tags.find(t => t.key === 'run_id')?.value || null,
            service: tags.find(t => t.key === 'service')?.value || null,
            environment: tags.find(t => t.key === 'environment')?.value || null,
          },
        });
      } catch (e) { return err(e); }
    },
  };
}

export function createSentryGetIssueEventsTool(deps: SentryToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_get_issue_events',
    description: 'Get recent events for a Sentry issue. Detects temporal patterns (burst, steady, regression).',
    params: {
      issueId: { type: 'string', description: 'Sentry issue ID' },
      limit: { type: 'number', min: 1, max: 100, default: 25, required: false },
    },
    execute: async ({ issueId, limit = 25 }) => {
      try {
        const events = await sentryFetch(config,
          `/issues/${issueId}/events/?limit=${limit}`
        ) as Array<Record<string, unknown>>;

        const mapped = events.map(e => {
          const tags = (e.tags || []) as Array<{ key: string; value: string }>;
          return {
            eventId: e.eventID, timestamp: e.dateCreated,
            message: e.message || e.title,
            traceId: tags.find(t => t.key === 'trace_id')?.value,
            runId: tags.find(t => t.key === 'run_id')?.value,
            service: tags.find(t => t.key === 'service')?.value,
            environment: tags.find(t => t.key === 'environment')?.value,
            release: tags.find(t => t.key === 'release')?.value,
          };
        });

        const pattern = detectTemporalPattern(mapped.map(e => e.timestamp as string));
        const services = [...new Set(mapped.map(e => e.service).filter(Boolean))];
        const environments = [...new Set(mapped.map(e => e.environment).filter(Boolean))];

        return json({ total: mapped.length, pattern, affectedServices: services, affectedEnvironments: environments, events: mapped });
      } catch (e) { return err(e); }
    },
  };
}

export function createSentryResolveIssueTool(deps: SentryToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_resolve_issue',
    description: 'Update a Sentry issue status: resolve, ignore, or unresolve.',
    params: {
      issueId: { type: 'string', description: 'Sentry issue ID' },
      action: { type: 'enum', values: ['resolve', 'ignore', 'unresolve'] },
      ignoreDuration: { type: 'number', required: false, description: 'Minutes to ignore (omit = forever)' },
    },
    execute: async ({ issueId, action, ignoreDuration }) => {
      try {
        let body: Record<string, unknown>;
        if (action === 'resolve') body = { status: 'resolved' };
        else if (action === 'ignore') body = ignoreDuration ? { status: 'ignored', statusDetails: { ignoreDuration } } : { status: 'ignored' };
        else body = { status: 'unresolved' };

        const result = await sentryFetch(config, `/issues/${issueId}/`, { method: 'PUT', body });
        return json({ success: true, action, issueId, result });
      } catch (e) { return err(e); }
    },
  };
}

export function createSentrySearchByTraceTool(deps: SentryToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'sentry_search_by_trace',
    description: 'Find all Sentry errors linked to a specific OTel trace ID across projects.',
    params: {
      traceId: { type: 'string', description: 'OTel trace ID (32-char hex)' },
      project: { type: 'string', required: false, description: 'Limit to specific project' },
    },
    execute: async ({ traceId, project }) => {
      try {
        const query = `trace_id:${traceId}`;
        const projectFilter = project ? `&project=${project}` : '';
        const issues = await sentryFetch(config,
          `/issues/?query=${encodeURIComponent(query)}${projectFilter}&limit=50`
        ) as Array<Record<string, unknown>>;

        const results = issues.map((i: Record<string, unknown>) => ({
          id: i.id, shortId: i.shortId, title: i.title,
          culprit: i.culprit, level: i.level, count: i.count,
          project: (i.project as Record<string, unknown>)?.slug,
          firstSeen: i.firstSeen, lastSeen: i.lastSeen,
        }));

        return json({
          traceId, issuesFound: results.length, issues: results,
          hint: results.length === 0
            ? 'No Sentry errors found for this trace. Verify enrichSentryEvent() is called in beforeSend.'
            : null,
        });
      } catch (e) { return err(e); }
    },
  };
}

export function createSentryProjectStatsTool(deps: SentryToolDeps): ToolDefinition {
  const { config } = deps;
  const projects = config.sentry.projects;

  return {
    name: 'sentry_project_stats',
    description: 'Get error rate trends for a Sentry project over a time range.',
    params: {
      project: projects.length > 0
        ? { type: 'enum', values: projects, description: 'Sentry project slug' }
        : { type: 'string', description: 'Sentry project slug' },
      stat: { type: 'enum', values: ['received', 'rejected', 'blacklisted'], default: 'received', required: false },
      interval: { type: 'enum', values: ['1h', '1d'], default: '1d', required: false },
      period: { type: 'string', default: '14d', description: 'Lookback period (e.g., "7d", "14d")', required: false },
    },
    execute: async ({ project, stat = 'received', interval = '1d', period = '14d' }) => {
      try {
        const data = await sentryFetch(config,
          `/stats_v2/?project=${project}&field=sum(quantity)&category=error&outcome=${stat}&interval=${interval}&statsPeriod=${period}`
        );
        return json({ project, stat, interval, period, data });
      } catch (e) { return err(e); }
    },
  };
}
```

**Step 2: Commit**

```bash
git add src/core/tools/sentry.ts
git commit -m "feat: convert 6 sentry tools to ToolParamDef format"
```

---

### Task 6: Convert Diagnosis tools (2) to ToolParamDef format

**Files:**
- Create: `src/core/tools/diagnosis.ts`

**Step 1: Write src/core/tools/diagnosis.ts**

Move `buildDiagnosis()` and `DiagnosisInput` here. Convert 2 tools to factory functions.

The full file is identical logic to old `src/tools/diagnosis.ts` but with:
- `ToolDefinition` return type instead of `server.tool()`
- Imports from `../helpers/` instead of `../helpers.js`
- `execute` returns `string` via `json()`/`err()`

```typescript
import type { ToolDefinition } from './types.js';
import type { AgentConfig } from '../types/config.js';
import { sentryFetch } from '../helpers/sentry.js';
import { extractStacktrace, extractBreadcrumbs } from '../helpers/temporal.js';
import { json, err } from '../helpers/response.js';

interface DiagnosisToolDeps {
  config: AgentConfig;
}

/* ─── Diagnosis Engine (exported for reuse) ─── */

export interface DiagnosisInput {
  title: string; culprit: string; count: number; userCount: number;
  level: string; stacktrace: string[];
  breadcrumbs: Array<{ timestamp: string; category: string; message: string }>;
  tags: Array<{ key: string; value: string }>;
  firstSeen: string; lastSeen: string; project: string;
}

export function buildDiagnosis(config: AgentConfig, input: DiagnosisInput) {
  // ... exact same body as current src/tools/diagnosis.ts buildDiagnosis() ...
  // (copy the full function body unchanged — lines 125-253 of old file)
}

/* ─── Tool factories ─── */

export function createDiagnoseIssueTool(deps: DiagnosisToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'diagnose_issue',
    description: 'Deep root-cause analysis of a Sentry issue. Examines stack trace, error patterns, frequency, and platform-specific knowledge to produce actionable diagnosis.',
    params: {
      issueId: { type: 'string', description: 'Sentry issue ID to diagnose' },
    },
    execute: async ({ issueId }) => {
      try {
        const [issue, latestEvent] = await Promise.all([
          sentryFetch(config, `/issues/${issueId}/`) as Promise<Record<string, unknown>>,
          sentryFetch(config, `/issues/${issueId}/events/latest/`) as Promise<Record<string, unknown>>,
        ]);

        const stacktrace = extractStacktrace(latestEvent);
        const breadcrumbs = extractBreadcrumbs(latestEvent);
        const tags = (latestEvent.tags || []) as Array<{ key: string; value: string }>;

        const diagnosis = buildDiagnosis(config, {
          title: String(issue.title || ''),
          culprit: String(issue.culprit || ''),
          count: Number(issue.count || 0),
          userCount: Number(issue.userCount || 0),
          level: String(issue.level || 'error'),
          stacktrace, breadcrumbs, tags,
          firstSeen: String(issue.firstSeen || ''),
          lastSeen: String(issue.lastSeen || ''),
          project: String((issue.project as Record<string, unknown>)?.slug || 'unknown'),
        });

        return json(diagnosis);
      } catch (e) { return err(e); }
    },
  };
}

export function createCrossCorrelateTool(deps: DiagnosisToolDeps): ToolDefinition {
  const { config } = deps;

  return {
    name: 'cross_correlate',
    description: 'Correlate errors across services using trace_id or run_id. Finds related Sentry issues across all projects.',
    params: {
      traceId: { type: 'string', required: false, description: 'OTel trace ID (32-char hex)' },
      runId: { type: 'string', required: false, description: 'Run ID (UUID)' },
    },
    execute: async ({ traceId, runId }) => {
      if (!traceId && !runId) return err('Provide at least one of traceId or runId');

      try {
        // ... exact same body as current cross_correlate tool ...
        // (copy the full execute body unchanged)
      } catch (e) { return err(e); }
    },
  };
}
```

**Note to implementer:** Copy the full `buildDiagnosis()` body (lines 124-253 of old `src/tools/diagnosis.ts`) and the full `cross_correlate` execute body (lines 51-110) verbatim. Only change the return format: `return json(...)` instead of `return { content: [...] }`.

**Step 2: Commit**

```bash
git add src/core/tools/diagnosis.ts
git commit -m "feat: convert 2 diagnosis tools to ToolParamDef format"
```

---

### Task 7: Convert OpenMeter tools (4) to ToolParamDef format

**Files:**
- Create: `src/core/tools/openmeter.ts`

**Step 1: Write src/core/tools/openmeter.ts**

Convert 4 tools. Same pattern: factory functions returning `ToolDefinition`. Import `getPgPool` from `../helpers/postgres.js`.

Each tool factory receives `{ config }` deps. The SQL queries and logic remain identical. Only the wrapper changes from `server.tool(name, desc, zodSchema, handler)` to `{ name, description, params: ToolParamDef, execute }`.

**Key params conversions:**
- `z.number().min(1).max(168).default(24)` → `{ type: 'number', min: 1, max: 168, default: 24, required: false }`
- `z.string().optional()` → `{ type: 'string', required: false }`
- `z.boolean().default(true)` → `{ type: 'boolean', default: true, required: false }`

Export 4 factory functions: `createOutboxHealthTool`, `createUsageByOrgTool`, `createDeadLetterRetryTool`, `createUsageAnomalyTool`.

**Step 2: Commit**

```bash
git add src/core/tools/openmeter.ts
git commit -m "feat: convert 4 openmeter tools to ToolParamDef format"
```

---

### Task 8: Convert Config Health (2) and AutoFix (2) tools

**Files:**
- Create: `src/core/tools/config-health.ts`
- Create: `src/core/tools/autofix.ts`

**Step 1: Write src/core/tools/config-health.ts**

Convert `check_config_health` and `check_conventions`. Dynamic enums from config: use `{ type: 'enum', values: [...] }` when available, fall back to `{ type: 'string' }` when empty.

**Step 2: Write src/core/tools/autofix.ts**

Convert `suggest_alert_rules` and `generate_runbook`. Same pattern.

**Step 3: Commit**

```bash
git add src/core/tools/config-health.ts src/core/tools/autofix.ts
git commit -m "feat: convert config-health and autofix tools to ToolParamDef format"
```

---

### Task 9: Create tool factory and core barrel export

**Files:**
- Create: `src/core/tools/index.ts`
- Create: `src/core/index.ts`

**Step 1: Write src/core/tools/index.ts**

```typescript
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
```

**Step 2: Write src/core/index.ts**

```typescript
export * from './config/index.js';
export * from './tools/index.js';
export type * from './types/config.js';
export { PLUGIN_ID, PLUGIN_NAME, PLUGIN_VERSION } from './plugin-id.js';
```

**Step 3: Commit**

```bash
git add src/core/tools/index.ts src/core/index.ts
git commit -m "feat: add createAllTools factory and core barrel export"
```

---

### Task 10: Move resources to core/resources/

**Files:**
- Create: `src/core/resources/conventions.ts`
- Create: `src/core/resources/services.ts`
- Create: `src/core/resources/sampling.ts`

**Step 1: Create pure data functions**

Each file exports a function that takes `config: AgentConfig` and returns the data object (no MCP dependency). The MCP wrapping happens in `mcp.ts`.

Example for `conventions.ts`:
```typescript
import type { AgentConfig } from '../types/config.js';

export function getConventionsData(config: AgentConfig) {
  return {
    services: config.services,
    spanNames: config.conventions.spanNames,
    attributeKeys: config.conventions.attributeKeys,
    rules: config.conventions.rules,
  };
}
```

Same pattern for `services.ts` (`getServicesData`) and `sampling.ts` (`getSamplingData`).

**Step 2: Commit**

```bash
git add src/core/resources/
git commit -m "refactor: move resource data functions to core/resources/"
```

---

### Task 11: Create MCP entry point (mcp.ts)

**Files:**
- Create: `src/mcp.ts`

**Step 1: Write src/mcp.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig } from './core/config/index.js';
import { createAllTools } from './core/tools/index.js';
import { toZodSchema } from './adapters/zod-schema.js';
import { PLUGIN_NAME, PLUGIN_VERSION } from './core/plugin-id.js';
import { getConventionsData } from './core/resources/conventions.js';
import { getServicesData } from './core/resources/services.js';
import { getSamplingData } from './core/resources/sampling.js';
import type { AgentConfig } from './core/types/config.js';

function registerResources(server: McpServer, config: AgentConfig) {
  const prefix = config.platform.name;

  server.resource('conventions', `${prefix}://conventions`,
    { mimeType: 'application/json', description: 'Observability conventions' },
    async () => ({ contents: [{ uri: `${prefix}://conventions`, mimeType: 'application/json', text: JSON.stringify(getConventionsData(config), null, 2) }] }),
  );

  server.resource('services', `${prefix}://services`,
    { mimeType: 'application/json', description: 'Service topology and dependencies' },
    async () => ({ contents: [{ uri: `${prefix}://services`, mimeType: 'application/json', text: JSON.stringify(getServicesData(config), null, 2) }] }),
  );

  server.resource('sampling', `${prefix}://sampling`,
    { mimeType: 'application/json', description: 'Sampling strategy reference' },
    async () => ({ contents: [{ uri: `${prefix}://sampling`, mimeType: 'application/json', text: JSON.stringify(getSamplingData(config), null, 2) }] }),
  );
}

function registerPrompts(server: McpServer, config: AgentConfig) {
  const serviceList = Object.keys(config.services).join(', ');

  server.prompt('triage-issue', 'Guided workflow to triage a Sentry issue.',
    { issueId: z.string().describe('Sentry issue ID') },
    async ({ issueId }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Triage Sentry issue ${issueId}:\n\n1. Use \`sentry_get_issue\` for full details.\n2. Use \`diagnose_issue\` for root cause analysis.\n3. If trace_id exists, use \`cross_correlate\` to check cascade.\n4. Use \`sentry_get_issue_events\` for temporal patterns.\n5. Use \`generate_runbook\` for the diagnosed category.\n6. If critical/high, use \`suggest_alert_rules\` for coverage.\n\nSummarize: root cause, severity, blast radius, recommended action, long-term fix.` } }],
    }),
  );

  server.prompt('production-readiness', 'Full production readiness audit.', {},
    async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Production readiness audit:\n\n1. \`check_config_health\` with environment="production"\n2. For each service [${serviceList}]: \`check_conventions\`\n3. \`openmeter_outbox_health\` (24h)\n4. \`openmeter_usage_anomaly\` for billing health\n5. For each Sentry project: \`suggest_alert_rules\`\n6. \`sentry_list_issues\` with query="is:unresolved level:fatal"\n\nProduce a scorecard: overall score (0-100), critical blockers, warnings, recommendations.` } }],
    }),
  );

  server.prompt('incident-response', 'Guided incident response workflow.',
    { service: z.string().optional().describe('Affected service'), symptom: z.string().optional().describe('Symptom description') },
    async ({ service, symptom }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Incident response for ${service || 'unknown service'}: ${symptom || 'errors detected'}\n\n## Phase 1: Assess\n1. \`sentry_list_issues\` sorted by priority\n2. \`sentry_get_issue\` for top 3\n3. \`cross_correlate\` to assess blast radius\n\n## Phase 2: Diagnose\n4. \`diagnose_issue\` for primary issue\n5. \`generate_runbook\` for the category\n6. \`openmeter_outbox_health\`\n\n## Phase 3: Mitigate\n7. Follow runbook mitigation steps\n8. If critical: recommend rollback\n9. \`sentry_resolve_issue\` when fixed\n\n## Phase 4: Document\nTimeline, root cause, services affected, user impact, actions taken, follow-ups.` } }],
    }),
  );
}

export function createObservabilityServer(env: Record<string, string | undefined> = process.env) {
  const config = loadConfig({
    sentryAuthToken: env.SENTRY_AUTH_TOKEN,
    sentryOrg: env.SENTRY_ORG,
    databaseUrl: env.DATABASE_URL,
    configPath: env.AGENT_CONFIG_PATH,
  });

  const server = new McpServer({ name: PLUGIN_NAME, version: PLUGIN_VERSION });

  const tools = createAllTools({ config });
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      toZodSchema(tool.params).shape,
      async (params: Record<string, unknown>) => {
        const result = await tool.execute(params);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    );
  }

  registerResources(server, config);
  registerPrompts(server, config);

  return server;
}
```

**Step 2: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: create MCP entry point with tools, resources, prompts"
```

---

### Task 12: Create OpenClaw entry point, commands, and plugin manifest

**Files:**
- Create: `src/openclaw.ts`
- Create: `src/core/commands/index.ts`
- Create: `src/core/commands/obs-status.ts`
- Create: `src/core/commands/obs-check.ts`
- Create: `openclaw.plugin.json`

**Step 1: Write src/core/commands/obs-status.ts**

```typescript
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
```

**Step 2: Write src/core/commands/obs-check.ts**

```typescript
import type { AgentConfig } from '../types/config.js';
import type { ToolDefinition } from '../tools/types.js';

export function createObsCheckHandler(deps: { config: AgentConfig; tools: ToolDefinition[] }) {
  return async (args?: string): Promise<string> => {
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
```

**Step 3: Write src/core/commands/index.ts**

```typescript
import type { AgentConfig } from '../types/config.js';
import type { ToolDefinition } from '../tools/types.js';
import { createObsStatusHandler } from './obs-status.js';
import { createObsCheckHandler } from './obs-check.js';

export interface CommandDependencies {
  config: AgentConfig;
  tools: ToolDefinition[];
}

export function registerAllCommands(api: any, deps: CommandDependencies): void {
  api.registerCommand({
    name: 'obs-status',
    description: 'Show observability agent status (config, services, connections)',
    handler: createObsStatusHandler({ config: deps.config }),
  });

  api.registerCommand({
    name: 'obs-check',
    description: 'Run observability health checks (config audit + outbox health)',
    handler: createObsCheckHandler({ config: deps.config, tools: deps.tools }),
  });
}
```

**Step 4: Write src/openclaw.ts**

```typescript
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
```

**Step 5: Write openclaw.plugin.json**

```json
{
  "id": "lucid-observability",
  "name": "Lucid Observability Agent",
  "version": "3.0.0",
  "description": "Sentry monitoring, root-cause diagnosis, billing pipeline health, incident runbooks",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "sentryAuthToken": { "type": "string" },
      "sentryOrg": { "type": "string" },
      "databaseUrl": { "type": "string" },
      "configPath": { "type": "string" }
    }
  },
  "uiHints": {
    "sentryAuthToken": { "label": "Sentry Auth Token", "sensitive": true },
    "sentryOrg": { "label": "Sentry Org Slug", "placeholder": "your-org" },
    "databaseUrl": { "label": "PostgreSQL URL", "sensitive": true, "placeholder": "postgresql://..." },
    "configPath": { "label": "Config File Path", "placeholder": "./config/lucid.json" }
  }
}
```

**Step 6: Commit**

```bash
git add src/openclaw.ts src/core/commands/ openclaw.plugin.json
git commit -m "feat: create OpenClaw plugin entry point, commands, and manifest"
```

---

### Task 13: Create bin.ts, index.ts, and SKILL.md

**Files:**
- Create: `src/bin.ts`
- Create: `src/index.ts`
- Create: `skills/lucid-observability/SKILL.md`

**Step 1: Write src/bin.ts**

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createObservabilityServer } from './mcp.js';

const server = createObservabilityServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 2: Write src/index.ts**

```typescript
export { default } from './openclaw.js';
```

**Step 3: Write skills/lucid-observability/SKILL.md**

```markdown
# Lucid Observability Agent

Tools for monitoring, diagnosing, and resolving observability issues across Sentry, OpenMeter, and OpenTelemetry.

## Available Tools

### Sentry (6)
- `sentry_list_issues` — List issues by project with search syntax
- `sentry_get_issue` — Full detail with stack trace and cross-links
- `sentry_get_issue_events` — Event history with temporal pattern detection
- `sentry_resolve_issue` — Resolve, ignore, or unresolve
- `sentry_search_by_trace` — Find errors by OTel trace ID
- `sentry_project_stats` — Error rate trends over time

### Diagnosis (2)
- `diagnose_issue` — Root cause analysis with pattern matching
- `cross_correlate` — Cross-service error correlation

### OpenMeter (4)
- `openmeter_outbox_health` — Queue depth, dead letters, stuck leases
- `openmeter_usage_by_org` — Per-org token/tool usage breakdown
- `openmeter_dead_letter_retry` — Retry failed dead-letter events
- `openmeter_usage_anomaly` — Spike/drop detection vs baseline

### Configuration (2)
- `check_config_health` — Audit env vars for production readiness
- `check_conventions` — Verify service conventions compliance

### Auto-Fix (2)
- `suggest_alert_rules` — Generate Sentry alert configs from patterns
- `generate_runbook` — Incident runbook for error categories

## Workflows

### Triage an Issue
1. `sentry_get_issue` for full details
2. `diagnose_issue` for root cause analysis
3. If trace_id exists, `cross_correlate` to check cascade
4. `sentry_get_issue_events` for temporal patterns
5. `generate_runbook` for the diagnosed category
6. If critical/high, `suggest_alert_rules` for coverage

### Production Readiness Audit
1. `check_config_health` with environment="production"
2. `check_conventions` for each service
3. `openmeter_outbox_health` (24h lookback)
4. `openmeter_usage_anomaly` for billing health
5. `suggest_alert_rules` for each Sentry project
6. `sentry_list_issues` for unresolved fatal errors

### Incident Response
1. **Assess**: `sentry_list_issues` sorted by priority, `cross_correlate` for blast radius
2. **Diagnose**: `diagnose_issue`, `generate_runbook`, `openmeter_outbox_health`
3. **Mitigate**: Follow runbook steps, `sentry_resolve_issue` when fixed
4. **Document**: Timeline, root cause, impact, follow-ups

## Heartbeat Checklist
Use these in your HEARTBEAT.md for autonomous monitoring:
- Run `openmeter_outbox_health` — alert if dead letters > 0 or stuck leases
- Run `sentry_list_issues` sorted by freq — flag issues with count > 100
- Run `check_config_health` — warn if any critical checks failing
- If issues found, run `diagnose_issue` and suggest resolution
```

**Step 4: Commit**

```bash
git add src/bin.ts src/index.ts skills/
git commit -m "feat: add CLI binary, index re-export, and OpenClaw skill"
```

---

### Task 14: Update config files and clean up old files

**Files:**
- Modify: `config/lucid.json` (remove webhook/periodicChecks blocks)
- Modify: `config/example.json` (remove webhook/periodicChecks blocks)
- Delete: `src/auto-resolve.ts`
- Delete: `src/webhook.ts`
- Delete: `src/scheduler.ts`
- Delete: `src/service.ts`
- Delete: `src/server.ts`
- Delete: `src/helpers.ts`
- Delete: `src/config.ts`
- Delete: `src/resources.ts`
- Delete: `src/prompts.ts`
- Delete: `src/tools/` (old directory)

**Step 1: Update config/lucid.json**

Remove the `"webhook"` and `"periodicChecks"` JSON blocks. Keep everything else.

**Step 2: Update config/example.json**

Same — remove `"webhook"` and `"periodicChecks"` blocks.

**Step 3: Delete old files**

```bash
cd /c/lucid-observability-agent
rm -f src/auto-resolve.ts src/webhook.ts src/scheduler.ts src/service.ts
rm -f src/server.ts src/helpers.ts src/config.ts src/resources.ts src/prompts.ts
rm -rf src/tools/
```

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old files (webhook, scheduler, auto-resolve, flat helpers)"
```

---

### Task 15: Typecheck, build, and final commit

**Step 1: Run typecheck**

Run: `cd /c/lucid-observability-agent && npx tsc --noEmit`

Fix any type errors. Common issues to expect:
- Import path resolution (`.js` extensions required for ESM)
- `AgentConfig` missing `webhook`/`periodicChecks` fields referenced somewhere
- Response helper return type mismatches (old `ok()` returned MCP objects, new returns `string`)

**Step 2: Build with tsup**

Run: `npx tsup`

Verify output:
- `dist/index.js` (OpenClaw entry)
- `dist/mcp.js` (MCP entry)
- `dist/bin.js` (CLI)
- `dist/openclaw.js`
- `dist/core/index.js`
- `.d.ts` files for all entries

**Step 3: Smoke test MCP server**

Run: `echo '{}' | node dist/bin.js`

Should start without errors (will exit since no valid JSON-RPC on stdin).

**Step 4: Final commit and tag**

```bash
git add -A
git commit -m "feat: v3.0.0 — dual MCP + OpenClaw plugin with ToolParamDef architecture"
git tag v3.0.0
```

**Step 5: Push**

```bash
git push origin main --tags
```

---

### Task 16: Update README.md

**Files:**
- Modify: `README.md`

**Step 1: Update README**

Update to reflect v3.0.0 changes:
- New installation options (MCP vs OpenClaw plugin)
- Remove webhook/scheduler/service sections
- Add OpenClaw plugin setup instructions
- Add HEARTBEAT.md example
- Update Quick Start with new binary name `lucid-obs-agent`
- Remove `start:service` and `dev:service` from Development section

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for v3.0.0 dual entry point architecture"
git push origin main
```
