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
