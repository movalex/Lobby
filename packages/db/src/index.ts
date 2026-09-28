// Postgres access for apps/api (docs/M1-CONTRACTS.md §2). Node only.

import { openPgPool } from './pg.ts'
import { openPglite } from './pglite.ts'
import type { Db, DbConfig } from './types.ts'

export { ID_PREFIXES, type IdPrefix, isId, newBoardId, newId } from './ids.ts'
export {
  checksumOf,
  loadMigrations,
  MIGRATIONS_DIR,
  type MigrateOptions,
  type MigrateResult,
  type Migration,
  migrate,
} from './migrate.ts'
export { openPglite, type PgliteDb } from './pglite.ts'
export {
  type Db,
  type DbConfig,
  isUniqueViolation,
  pgErrorCode,
  type Queryable,
  type QueryResult,
  type Row,
} from './types.ts'

export async function openDb(config: DbConfig): Promise<Db> {
  if (config.kind === 'pg') return openPgPool(config)
  return openPglite(config)
}
