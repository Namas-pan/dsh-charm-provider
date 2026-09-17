/**
 * Rebuild this plugin and install it into a dsh profile.
 *
 * Doing this by hand has three papercuts this script removes:
 *   - `dsh plugin add <absolute path>` mis-resolves a Windows drive letter
 *     (`file:E:/...` gets appended to the profile directory), so the tarball is
 *     copied INTO the profile and added by relative name from there;
 *   - pnpm will not re-extract a tarball whose name and version it already
 *     resolved, so the version is bumped by default;
 *   - the stale tarball of the previous version is removed afterwards, because
 *     pnpm re-resolves every `file:` dependency on the next install.
 *
 * Usage:
 *   node scripts/install.mjs                    # build, patch-bump, pack, install into `web`
 *   node scripts/install.mjs --profile dsh-tui  # another profile (each owns its plugin list)
 *   node scripts/install.mjs --pack-only        # build + pack only, touch no profile
 *   node scripts/install.mjs --no-bump          # keep the current version
 *
 * A new bundle is composed at boot, so the target profile needs a restart of
 * its front door before the plugin mounts.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const PROFILE = flag('--profile', 'web')
const PACK_ONLY = argv.includes('--pack-only')
const BUMP = !argv.includes('--no-bump')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd ?? ROOT,
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error(`install: \`${command} ${args.join(' ')}\` failed (${result.status})`)
    process.exit(result.status ?? 1)
  }
}

/* ------------------------------------------------------------- version */

const manifestPath = join(ROOT, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
if (BUMP) {
  const [major, minor, patch] = manifest.version.split('.').map(Number)
  manifest.version = `${major}.${minor}.${patch + 1}`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  console.log(`version: ${manifest.version}`)
}

/* ---------------------------------------------------------------- build */

run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')])

/* ----------------------------------------------------------------- pack */

const dist = join(ROOT, 'dist')
run('pnpm', ['pack', '--pack-destination', dist])

const unscoped = manifest.name.replace('@', '').replace('/', '-')
const tarball = `${unscoped}-${manifest.version}.tgz`
const packed = join(dist, tarball)
if (!existsSync(packed)) {
  console.error(`install: expected ${packed} after pack`)
  process.exit(1)
}
if (PACK_ONLY) {
  console.log(`packed: ${packed}`)
  process.exit(0)
}

/* ------------------------------------------------------------- install */

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', PROFILE)
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`install: profile "${PROFILE}" not found at ${profileDir}`)
  process.exit(1)
}

const staged = join(profileDir, tarball)
copyFileSync(packed, staged)

/**
 * Names this package was installed under before. Leaving one in place would
 * mount TWO rows carrying the same `llm-hyper` id and register the `hyper`
 * route twice, which fails the boot — so a former install is removed first.
 */
const FORMER_NAMES = ['@dsh-external/dsh-charm-provider', 'dsh-hyper-provider']
const tarballPrefixes = [manifest.name, ...FORMER_NAMES].map(name => `${name.replace('@', '').replace('/', '-')}-`)

const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf-8'))
for (const former of FORMER_NAMES) {
  if (profileManifest.dependencies?.[former] !== undefined) {
    console.log(`migrating: removing ${former} (it would register the same route twice)`)
    run('dsh', ['plugin', '--profile', PROFILE, 'remove', former], { cwd: profileDir })
  }
}

for (const entry of readdirSync(profileDir)) {
  const stale = entry.endsWith('.tgz') && entry !== tarball && tarballPrefixes.some(prefix => entry.startsWith(prefix))
  if (stale) {
    rmSync(join(profileDir, entry), { force: true })
    console.log(`removed stale: ${entry}`)
  }
}

// `dsh plugin` delegates to pnpm in the profile directory: run from there and
// name the tarball relatively, which is what keeps the Windows path resolution
// inside the profile.
run('dsh', ['plugin', '--profile', PROFILE, 'add', `./${tarball}`], { cwd: profileDir })

const bundles = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf-8')).dsh?.profile?.bundles ?? []
console.log(`\ninstalled ${manifest.name}@${manifest.version} into profile "${PROFILE}"`)
console.log(bundles.includes(manifest.name)
  ? 'bundle registered.'
  : `warning: ${manifest.name} is missing from dsh.profile.bundles — add it there or the row never mounts.`)
console.log(`restart the "${PROFILE}" front door, then reload the GUI to mount it.`)