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
