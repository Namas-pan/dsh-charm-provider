/**
 * End-to-end verification of the Hyper provider against the live API.
 *
 * It loads the built plugin (`lib/index.js`) with a stub Cordis context, captures
 * the adapter it registers, and drives that adapter's real code paths:
 *
 *   1. `listModels`   — the live catalog (no credential needed)
 *   2. `resolveModel` — image modality and reasoning levels for one model
 *   3. plain stream   — text deltas, usage, terminal `finish{stop}`
 *   4. reasoning      — `reasoning_effort` accepted and reasoning deltas surfaced
 *   5. tool calling   — an assistant `tool-call` block with raw JSON arguments
 *   6. image input    — a generated PNG accepted by a vision model
 *
 * The key is never printed: it comes from `HYPER_API_KEY`, or from the managed
 * credential store `$DSH_HOME/.credentials.yaml` under the plugin's reference.
 *
 * Usage: node scripts/verify-live.mjs [--model <id>] [--runtime <dir>]
 */
import { deflateSync } from 'node:zlib'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findRuntime, runtimeArgument } from './runtime.mjs'

const argv = process.argv.slice(2)
const modelArgument = argv.indexOf('--model')
const MODEL = modelArgument >= 0 ? argv[modelArgument + 1] : 'deepseek-v4.1-flash'
const PLUGIN = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const noRuntime = argv.includes('--no-runtime')
const RUNTIME = noRuntime ? undefined : findRuntime(runtimeArgument(argv))
/** Peers from the installed runtime, else from this package's own node_modules. */
const PEER_ROOT = RUNTIME ?? join(PLUGIN, 'node_modules')
const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-typert-protocol',
]
const CREDENTIAL_REF = 'HYPER_API_KEY'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ------------------------------------------------------------------ key */

function readKey() {
  if (typeof process.env.HYPER_API_KEY === 'string' && process.env.HYPER_API_KEY.trim().length > 0) {
    return { value: process.env.HYPER_API_KEY.trim(), source: 'HYPER_API_KEY' }
  }
  const home = process.env.DSH_HOME
  if (home === undefined) return undefined
  const store = join(home, '.credentials.yaml')
  if (!existsSync(store)) return undefined
  const text = readFileSync(store, 'utf-8')
  const inline = new RegExp(`^\\s*${CREDENTIAL_REF}\\s*:\\s*["']?([^"'\\s#]+)["']?\\s*$`, 'm').exec(text)
  if (inline !== null) return { value: inline[1], source: `${store} (${CREDENTIAL_REF})` }
  const nested = new RegExp(`^\\s*${CREDENTIAL_REF}\\s*:\\s*\\n(?:\\s+\\w+:.*\\n)*?\\s+value\\s*:\\s*["']?([^"'\\s#]+)["']?`, 'm').exec(text)
  if (nested !== null) return { value: nested[1], source: `${store} (${CREDENTIAL_REF})` }
  return undefined
}

for (const peer of PEERS) {
  if (!existsSync(join(PEER_ROOT, peer, 'package.json'))) {
    console.error(`no peer ${peer} under ${PEER_ROOT}`)
    console.error('Install the devDependencies (pnpm install), or pass --runtime <dir containing @deepseek-ai/>')
    process.exit(1)
  }
}
const key = readKey()
if (key === undefined) {
  console.error(`no Hyper key found. Set HYPER_API_KEY, or store ${CREDENTIAL_REF} through Settings → Models → Hyper.`)
  console.error('(the key is read locally and never printed)')
  process.exit(2)
}
console.log(`plugin:  ${PLUGIN}`)
console.log(`model:   ${MODEL}`)
console.log(`key:     loaded from ${key.source}\n`)

/* --------------------------------------------------------------- loader */

const sandbox = mkdtempSync(join(tmpdir(), 'hyper-live-'))
mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai'), { recursive: true })
writeFileSync(join(sandbox, 'package.json'), '{ "type": "module" }\n', 'utf-8')
for (const peer of PEERS) symlinkSync(join(PEER_ROOT, peer), join(sandbox, 'node_modules', peer), 'junction')
cpSync(join(PLUGIN, 'lib', 'index.js'), join(sandbox, 'index.js'))

const mod = await import(pathToFileURL(join(sandbox, 'index.js')).href)

/* ---------------------------------------------------------------- stubs */

const CONFIG = {
  apiKeyEnv: CREDENTIAL_REF,
  baseURL: 'https://hyper.charm.land/v1',
  modelsCachePath: join(sandbox, 'models-cache.json'),
  catalogTtlMs: 6 * 60 * 60 * 1000,
  visibleModels: [],
  requestTimeoutMs: 60_000,
  streamIdleTimeoutMs: 300_000,
  defaultMaxTokens: 0,
}

const png = makePng(64, 64)
let captured
const scope = { get: () => CONFIG, watch: () => () => {} }
const ctx = {
  settings: { register: () => scope },
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: key.value }) }
    if (name === 'attachments') return { readImage: async () => ({ data: png, mediaType: 'image/png' }) }
    return undefined
  },
  llm: {
    registerConfigurableProviders(entries) { captured = { ...captured, providers: entries } },
    registerAdapter(providers, adapter) { captured = { ...captured, providers, adapter } },
  },
  // The real Service base registers itself through `ctx.reflect.provide`; the
  // Remote's scope supplies the registry that receives the invocation.
  reflect: { provide(name, instance) { captured = { ...captured, services: { ...captured?.services, [name]: instance } } } },
  effect(callback) { return callback() },
  inject(services, callback) {
    if (!services.includes('typert')) return
    callback({
      reflect: ctx.reflect,
      effect: () => () => {},
      typert: { register(contribution) { captured = { ...captured, contribution }; return () => {} } },
    })
  },
}

mod.apply(ctx, CONFIG)
const adapter = captured?.adapter
const creditsService = captured?.services?.hyperCredits
const contribution = captured?.contribution
check('adapter registered for the hyper route', adapter !== undefined && captured.providers.includes('hyper'))
check('credits Remote registered on the host',
  contribution?.package === 'dsh-charm-provider' && contribution?.invocations?.[0]?.namespace === 'hyper' && contribution?.invocations?.[0]?.method === 'credits',
  contribution === undefined ? 'no contribution' : `${contribution.invocations[0].namespace}/${contribution.invocations[0].method} via ${contribution.invocations[0].service}`)
check('credits service is provided under its invocation service key', typeof creditsService?.credits === 'function')

// The Gateway dispatches as Reflect.apply(ctx.get(serviceKey)[method], receiver,
// args), where that receiver is a traced WRAPPER rather than the instance. A
// method reading `this` (or a `#private` field) blows up there, so exercise that
// exact shape here: this is the regression check for the card failing with
// "Cannot read private member #read from an object whose class did not declare it".
let viaWrapper
try {
  const wrapper = new Proxy(creditsService, {})
  viaWrapper = await Reflect.apply(Reflect.get(wrapper, 'credits'), wrapper, [])
} catch (error) {
  viaWrapper = { failure: String(error.message ?? error) }
}
check('the credits method survives a wrapped receiver',
  viaWrapper?.failure === undefined && typeof viaWrapper.balance === 'number',
  viaWrapper?.failure ?? `balance=${viaWrapper?.balance} source=${viaWrapper?.source}`)

/* ------------------------------------------------------------- streaming */

const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const withImage = (text) => ({
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }, { type: 'image', attachment: { attachmentId: 'verify', mediaType: 'image/png', bytes: png.length, width: 64, height: 64 } }],
})

async function drain(options) {
  const chunks = []
  let failure
  try {
    for await (const chunk of adapter.stream({ provider: 'hyper', model: MODEL, ...options })) chunks.push(chunk)
  } catch (error) {
    failure = error
  }
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  const toolCalls = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call').map(c => c.block)
  const usage = chunks.find(c => c.type === 'usage')?.usage
  const finish = chunks.find(c => c.type === 'finish')?.reason
  return { chunks, text, reasoning, toolCalls, usage, finish, failure }
}

const models = await adapter.listModels('hyper')
// The vendor's catalog moves (34 models one day, 23 the next), so this asserts a
// usable catalog rather than a frozen count.
check('live catalog lists models', models.length > 5, `${models.length} models`)
const resolved = await adapter.resolveModel('hyper', MODEL)
check('resolveModel reports image + reasoning', resolved.inputModalities.includes('image') && (resolved.reasoning?.efforts.length ?? 0) > 0,
  `input=${resolved.inputModalities.join('+')} efforts=${(resolved.reasoning?.efforts ?? []).map(e => e.id).join(',')}`)

const creditsAtStart = await creditsService.credits()
check('credits endpoint answers through the service',
  typeof creditsAtStart.balance === 'number' && creditsAtStart.source === 'endpoint' && creditsAtStart.error === null,
  `balance=${creditsAtStart.balance} source=${creditsAtStart.source}${creditsAtStart.error === null ? '' : ` error=${creditsAtStart.error}`}`)

const plain = await drain({ messages: [user('Reply with exactly: pong')], maxTokens: 32 })
check('plain stream completes', plain.failure === undefined && plain.finish?.kind === 'stop', plain.failure === undefined ? `finish=${plain.finish?.kind} text=${JSON.stringify(plain.text.slice(0, 40))}` : String(plain.failure.message))
check('plain stream reports usage', (plain.usage?.inputTokens ?? 0) > 0 && (plain.usage?.outputTokens ?? 0) > 0, JSON.stringify(plain.usage))

const creditsAfter = await creditsService.credits()
// A streamed response reports `cost` but not `remaining`, so the card derives
// the live balance from the last endpoint reading minus the spend since.
check('a stream updates the spend and derives the balance',
  creditsAfter.requests >= 1 && creditsAfter.spentUsd > 0 && creditsAfter.spentCredits > 0 && typeof creditsAfter.balance === 'number',
  `requests=${creditsAfter.requests} spent=$${creditsAfter.spentUsd.toFixed(6)} credits=${creditsAfter.spentCredits.toFixed(4)} balance=${creditsAfter.balance} source=${creditsAfter.source} estimated=${creditsAfter.estimated}`)
check('the derived balance matches reading minus spend',
  creditsAfter.balance !== null && creditsAtStart.balance !== null
    && (creditsAfter.source === 'response' || Math.abs(creditsAfter.balance - (creditsAtStart.balance - creditsAfter.spentCredits)) < 1e-6),
  `endpoint=${creditsAtStart.balance} spent=${creditsAfter.spentCredits.toFixed(4)} shown=${creditsAfter.balance}`)

let hostRejectedBadFrame = false
try {
  contribution.invocations[0].result.schema.parse({ balance: 'nope' })
} catch {
  hostRejectedBadFrame = true
}
check('host descriptor validator rejects a malformed frame', hostRejectedBadFrame)

const reasoning = await drain({ messages: [user('What is 17*23? Think it through.')], reasoningEffort: 'max', maxTokens: 256 })
check('reasoning effort accepted', reasoning.failure === undefined && reasoning.finish?.kind === 'stop', `finish=${reasoning.finish?.kind} reasoning chars=${reasoning.reasoning.length}`)

const tool = await drain({
  messages: [user('Use the get_weather tool for Beijing. Do not answer in prose.')],
  tools: [{
    name: 'get_weather',
    description: 'Look up the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
  }],
  maxTokens: 256,
})
const call = tool.toolCalls[0]
let parsedArguments
try { parsedArguments = call === undefined ? undefined : JSON.parse(call.arguments) } catch { parsedArguments = undefined }
check('tool call streams as raw JSON arguments',
  call !== undefined && typeof call.name === 'string' && parsedArguments !== undefined && typeof parsedArguments.city === 'string',
  call === undefined ? `finish=${tool.finish?.kind}` : `${call.name}(${call.arguments})`)

const image = await drain({ messages: [withImage('Reply with exactly: seen')], maxTokens: 256 })
// A reasoning model may legitimately stop on `max-tokens`; what this check
// proves is that the provider accepted the image (no failure, no error finish).
const imageAccepted = image.failure === undefined && (image.finish?.kind === 'stop' || image.finish?.kind === 'max-tokens')
check('image input accepted by a vision model', imageAccepted,
  image.failure === undefined ? `finish=${image.finish?.kind} in=${image.usage?.inputTokens}` : String(image.failure.message))
check('image raises the prompt token count', (image.usage?.inputTokens ?? 0) > (plain.usage?.inputTokens ?? 0),
  `text-only=${plain.usage?.inputTokens} with-image=${image.usage?.inputTokens}`)

/* ------------------------------------------------------------------ png */

/** Smallest valid RGBA PNG of one flat colour, enough to exercise the wire. */
function makePng(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4
      raw[offset] = 32
      raw[offset + 1] = 96
      raw[offset + 2] = 200
      raw[offset + 3] = 255
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
