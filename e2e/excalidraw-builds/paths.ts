import { join } from 'node:path'
import { RUN_TAG } from '../tests/support/ports.ts'
import { REPO_ROOT } from '../tests/support/stack.ts'

/** Where prod.config.ts builds the production engine web app (relative to apps/web), per run. */
export const PROD_OUT_DIR = `dist/lp-${RUN_TAG}`
/** The same, absolute (the specs read the build output). */
export const PROD_DIST = join(REPO_ROOT, 'apps/web', PROD_OUT_DIR)
