/**
 * Build this plugin: typecheck `src/` against the installed DSH runtime and
 * emit `lib/`.
 *
 * Harness packages resolve through a generated `tsconfig.build.json` `paths`
 * map rather than through `node_modules`, so a deployment whose plugin folder
 * carries stale links still builds, and nothing is written outside this package.
 *
 * Usage:
 *   node scripts/build.mjs                 # typecheck + emit lib/
 *   node scripts/build.mjs --check         # typecheck only
 *   node scripts/build.mjs --runtime <dir> # explicit DSH runtime
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRuntime, runtimeArgument } from './runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
// `--no-runtime` skips runtime discovery and resolves the peers from this
// package's own node_modules. CI uses it to state that intent explicitly; it is
// also how the no-runtime path is tested on a machine that has a runtime.
const noRuntime = argv.includes('--no-runtime')

const runtime = noRuntime ? undefined : findRuntime(runtimeArgument(argv))

/** Module specifier -> directory in the runtime, for a generated `paths` map. */
const RESOLUTIONS = {
  '@deepseek-ai/cordis': '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery': '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-credentials': '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm': '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings': '@deepseek-ai/dsh-settings',
}

/**
 * Two ways to resolve the Harness peers, in order of preference:
 *
 *   1. an installed DSH runtime (a developer machine) — mapped through `paths`,
 *      so a profile's own `node_modules` needs no surgery;
 *   2. this package's own `node_modules` (CI, a fresh clone after
 *      `pnpm install`) — plain Node resolution, which needs no config at all.
 */
const localPeers = Object.values(RESOLUTIONS).every(target =>
  existsSync(join(ROOT, 'node_modules', target, 'package.json')))

let configPath = join(ROOT, 'tsconfig.json')
if (runtime !== undefined) {
  console.log(`runtime: ${runtime}`)
  for (const target of Object.values(RESOLUTIONS)) {
    if (!existsSync(join(runtime, target, 'package.json'))) {
      console.error(`build: ${target} is not installed in that runtime`)
      process.exit(1)
    }
  }
  const toPosix = value => value.replaceAll('\\', '/')
  const buildConfig = {
    extends: './tsconfig.json',
    compilerOptions: {
      // Resolution for this build goes through the explicit `paths` map below;
      // bundler mode honors it for bare specifiers without changing emit (this
      // package has no relative imports, so emitted specifiers stay untouched).
      module: 'ESNext',
      moduleResolution: 'Bundler',
      baseUrl: '.',
      paths: Object.fromEntries(
        Object.entries(RESOLUTIONS).map(([specifier, target]) => [specifier, [toPosix(join(runtime, target))]]),
      ),
    },
  }
  configPath = join(ROOT, 'tsconfig.build.json')
  writeFileSync(configPath, `${JSON.stringify(buildConfig, null, 2)}\n`, 'utf-8')
  console.log('wrote: tsconfig.build.json')
} else if (localPeers) {
  console.log('runtime: none found; resolving peers from this package\'s node_modules')
} else {
  console.error('build: no DSH runtime found and no local node_modules.')
  console.error('Either install the devDependencies (pnpm install), or pass one explicitly:')
  console.error('  node scripts/build.mjs --runtime <dir containing @deepseek-ai/>')
  process.exit(1)
}

const tsc = join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js')
if (!existsSync(tsc)) {
  console.error('build: typescript is not installed in this package (pnpm install)')
  process.exit(1)
}

const built = spawnSync(process.execPath, [tsc, '-p', configPath, ...(checkOnly ? ['--noEmit'] : [])], {
  stdio: 'inherit',
  cwd: ROOT,
})
if (built.status !== 0) process.exit(built.status ?? 1)
console.log(checkOnly ? 'typecheck complete' : 'build complete: lib/')
