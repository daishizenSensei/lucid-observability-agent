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
