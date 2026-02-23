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
