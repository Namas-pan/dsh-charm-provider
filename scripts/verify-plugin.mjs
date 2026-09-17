/**
 * Verify the built Hyper provider plugin without loading a DSH profile.
 *
 * What it proves:
 *   1. `lib/index.js` imports cleanly against the installed DSH runtime — every
 *      Harness peer it names actually resolves there.
 *   2. The plugin exports the contract the loader expects (`name`, `inject`,
 *      `apply`) and builds its route metadata (`PROVIDER`).
 *   3. `Config` resolves its schema defaults.
 *   4. `parseCatalog` maps the LIVE `GET https://hyper.charm.land/v1/models`
 *      payload — ids, context windows, vision, reasoning levels — which is the
 *      one part of the adapter that can be checked without an API key.
 *
 * The plugin directory's own `node_modules` is unusable (stale junctions), so
 * the artifact is imported from a clean temp tree holding links to the runtime.
 *
 * Usage: node scripts/verify-plugin.mjs [--plugin <dir>] [--runtime <dir>]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findRuntime, runtimeArgument } from './runtime.mjs'

const argv = process.argv.slice(2)
const pluginArgument = argv.indexOf('--plugin')
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = resolve(pluginArgument >= 0 ? argv[pluginArgument + 1] : PACKAGE_ROOT)
const noRuntime = argv.includes('--no-runtime')
const RUNTIME = noRuntime ? undefined : findRuntime(runtimeArgument(argv))

const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-typert-protocol',
]

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// Peers come from the installed runtime when there is one, otherwise from this
// package's own node_modules (CI, or `--no-runtime`).
const PEER_ROOT = RUNTIME ?? join(PACKAGE_ROOT, 'node_modules')
for (const peer of PEERS) {
  if (!existsSync(join(PEER_ROOT, peer, 'package.json'))) {
    console.error(`no peer ${peer} under ${PEER_ROOT}`)
    console.error('Install the devDependencies (pnpm install), or pass --runtime <dir containing @deepseek-ai/>')
    process.exit(1)
  }
}
console.log(`plugin:  ${PLUGIN}`)
console.log(`peers:   ${PEER_ROOT}\n`)

const sandbox = mkdtempSync(join(tmpdir(), 'hyper-verify-'))
mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai'), { recursive: true })
writeFileSync(join(sandbox, 'package.json'), '{ "type": "module" }\n', 'utf-8')
for (const peer of PEERS) {
  symlinkSync(join(PEER_ROOT, peer), join(sandbox, 'node_modules', peer), 'junction')
}
const artifact = join(PLUGIN, 'lib', 'index.js')
const staged = join(sandbox, 'index.js')
cpSync(artifact, staged)

let mod
try {
  mod = await import(pathToFileURL(staged).href)
  check('lib/index.js imports against the runtime', true)
} catch (error) {
  check('lib/index.js imports against the runtime', false, String(error.message ?? error))
  process.exitCode = 1
  throw new Error('artifact did not import; fix the build before the remaining checks')
}

check('exports name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
check('exports apply()', typeof mod.apply === 'function')
check('injects llm + settings', Array.isArray(mod.inject) && mod.inject.includes('llm') && mod.inject.includes('settings'), JSON.stringify(mod.inject))
check('route id is hyper', mod.PROVIDER === 'hyper', String(mod.PROVIDER))
check('settings namespace is llm-hyper', mod.NS === 'llm-hyper', String(mod.NS))

const defaults = mod.Config({})
check('Config defaults resolve', defaults.apiKeyEnv === 'HYPER_API_KEY' && defaults.baseURL === 'https://hyper.charm.land/v1',
  `${defaults.apiKeyEnv} / ${defaults.baseURL}`)
check('visibleModels defaults to all', Array.isArray(defaults.visibleModels) && defaults.visibleModels.length === 0)

/* ------------------------------------------------- credits remote wiring */

// Mount the plugin with a stub context and exercise the credits service the way
// the Gateway does: through `ctx.get(serviceKey)`, a WRAPPED receiver. A method
// reading `this` (or a `#private` field) throws there — the failure the balance
// card hit as "Cannot read private member #read from an object whose class did
// not declare it". This runs without a credential, so CI covers it.
let creditsService
const stub = {
  settings: { register: () => ({ get: () => defaults, watch: () => () => {} }) },
  get: () => undefined,
  llm: { registerConfigurableProviders() {}, registerAdapter() {} },
  reflect: { provide(name, instance) { if (name === 'hyperCredits') creditsService = instance } },
  effect: (callback) => callback(),
  inject(services, callback) {
    if (!services.includes('typert')) return
    callback({ reflect: stub.reflect, effect: () => () => {}, typert: { register: () => () => {} } })
  },
}
mod.apply(stub, defaults)
check('mounts the credits service', typeof creditsService?.credits === 'function')

let throughWrapper
try {
  const wrapper = new Proxy(creditsService, {})
  throughWrapper = await Reflect.apply(Reflect.get(wrapper, 'credits'), wrapper, [])
} catch (error) {
  throughWrapper = { failure: String(error.message ?? error) }
}
check('the credits method survives a wrapped receiver',
  throughWrapper?.failure === undefined && typeof throughWrapper.requests === 'number',
  throughWrapper?.failure ?? `balance=${throughWrapper?.balance} error=${throughWrapper?.error}`)
check('a keyless mount reports the failure instead of throwing',
  throughWrapper?.failure === undefined && throughWrapper?.balance === null && typeof throughWrapper?.error === 'string',
  String(throughWrapper?.error).slice(0, 80))

const response = await fetch(`${defaults.baseURL}/models`)
const payload = await response.json()
const models = mod.parseCatalog(payload)
check('live catalog parses', models.length === payload.data.length && models.length > 0, `${models.length} models`)

const flash = models.find(model => model.id === 'deepseek-v4.1-flash')
check('deepseek-v4.1-flash: vision + efforts from the endpoint',
  flash !== undefined && flash.vision === true && flash.efforts.map(e => e.value).join(',') === 'low,high,max',
  flash === undefined ? 'missing' : `vision=${flash.vision} efforts=${flash.efforts.map(e => e.value).join(',')}`)
check('catalog carries context windows', models.every(model => model.contextWindow > 0 && model.maxTokens > 0))

const names = models.map(model => model.name)
check('display names preferred over ids', names.includes('DeepSeek V4.1 Flash'))
check('pricing captured when published', models.filter(model => model.pricing?.input !== undefined).length > 0,
  `${models.filter(model => model.pricing?.input !== undefined).length} priced`)

/* ------------------------------------------------------- image wire, offline */

// The image path is where a stub once hid a real defect: `AttachmentStore.readImage`
// answers `{ ref, data }`, so a media type read off the payload becomes `undefined`,
// the part travels as `data:undefined;base64,…`, and the provider drops it without
// raising — the model then answers "I see no image". Drive one stream against a
// stubbed `fetch` and assert the request body carries a well-formed data URL.
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const visionModel = models.find(model => model.vision === true)
let streamAdapter
const streamStub = {
  settings: { register: () => ({ get: () => streamConfig, watch: () => () => {} }) },
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: 'sk-hyper-verify' }) }
    // The REAL store shape: the verified media type rides on the reference.
    if (name === 'attachments') return { readImage: async (ref) => ({ ref, data: pngBytes }) }
    return undefined
  },
  llm: { registerConfigurableProviders() {}, registerAdapter(_providers, adapter) { streamAdapter = adapter } },
  reflect: { provide() {} },
  effect: (callback) => callback(),
  inject() {},
}
const streamConfig = { ...defaults, modelsCachePath: join(sandbox, 'models-cache.json') }
mod.apply(streamStub, streamConfig)

const realFetch = globalThis.fetch
let capturedBody
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/models')) {
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  capturedBody = JSON.parse(String(init?.body ?? '{}'))
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const driveStream = async (messages) => {
  capturedBody = undefined
  try {
    for await (const _chunk of streamAdapter.stream({
      provider: 'hyper',
      model: visionModel?.id ?? 'deepseek-v4.1-flash',
      messages,
      maxTokens: 16,
    })) {
      // The verdict is the captured request body, not the reply.
    }
  } catch {
    // A stubbed stream may end early; the body was already captured.
  }
  return capturedBody
}
const imageBlock = {
  type: 'image',
  attachment: { attachmentId: 'sha256:verify', mediaType: 'image/png', bytes: pngBytes.length, width: 1, height: 1 },
}
const imageUrlIn = (body, role) => {
  for (const message of body?.messages ?? []) {
    if (role !== undefined && message.role !== role) continue
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'image_url') return part.image_url?.url ?? ''
    }
  }
  return ''
}
const dataUrlIsPng = (url) =>
  url.startsWith('data:image/png;base64,') && Buffer.from(url.split(',')[1] ?? '', 'base64').equals(Buffer.from(pngBytes))

let userImageBody
let toolImageBody
try {
  userImageBody = await driveStream([{
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'what is in this image?' }, imageBlock],
  }])
  // A tool result that carries an image: the tool message must stay string-only
  // and the image must follow the whole run of tool messages.
  toolImageBody = await driveStream([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_shot', name: 'screenshot', arguments: '{}' }] },
    {
      role: 'user',
      source: { kind: 'tool' },
      content: [{ type: 'tool-result', toolCallId: 'call_shot', content: [{ type: 'text', text: 'captured the window' }, imageBlock] }],
    },
  ])
} finally {
  globalThis.fetch = realFetch
}

const userImageUrl = imageUrlIn(userImageBody)
check('a user image travels as a data URL with the attachment media type',
  dataUrlIsPng(userImageUrl),
  userImageUrl === '' ? 'no image_url part in the request body' : userImageUrl.slice(0, 44))

const toolWire = toolImageBody?.messages ?? []
const toolMessage = toolWire.find(message => message.role === 'tool')
const trailing = toolWire[toolWire.length - 1]
check("a tool result's image follows its string-only tool message as one user message",
  typeof toolMessage?.content === 'string'
  && toolMessage.content.includes('captured the window')
  && toolWire.indexOf(toolMessage) === toolWire.length - 2
  && trailing?.role === 'user'
  && Array.isArray(trailing.content)
  && String(trailing.content[0]?.text ?? '').includes('Attached image(s) from tool result')
  && dataUrlIsPng(imageUrlIn(toolImageBody, 'user')),
  toolMessage === undefined
    ? 'no tool message was emitted'
    : `roles=${toolWire.map(message => message.role).join(',')} tool=${JSON.stringify(toolMessage.content).slice(0, 28)}`)

/**
 * Best-effort temp cleanup. Removing Windows junctions can abort the process
 * during teardown, so a failure here must never change the verdict.
 */
function cleanup() {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // the OS reclaims %TEMP% anyway
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
cleanup()
process.exitCode = failed.length === 0 ? 0 : 1
