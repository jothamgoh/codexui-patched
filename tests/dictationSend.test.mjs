import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build } from 'esbuild'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createRenderer, nextTick, reactive } from 'vue'
import { createPinia } from 'pinia'

// Exercise the real composer's setup and dictation lifecycle without a browser,
// rendering, microphone hardware, or calls to the live bridge.
const filename = new URL('../src/components/content/ThreadComposer.vue', import.meta.url).pathname
const { descriptor } = parse(await readFile(filename, 'utf8'), { filename })
const compiled = await build({
  stdin: { contents: compileScript(descriptor, { id: 'dictation-test' }).content, loader: 'ts', resolveDir: new URL('../src/components/content/', import.meta.url).pathname },
  bundle: true, write: false, platform: 'node', format: 'esm',
  external: ['vue', 'pinia'],
  plugins: [{ name: 'composer-fixture', setup(builder) {
    builder.onResolve({ filter: /\.vue$|^@\/components\/|^@lucide\/vue$/ }, args => ({ path: args.path, namespace: 'ui-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'ui-stub' }, () => ({ contents: 'export default {}; export const Blocks={},Check={},MessageSquare={},MessageSquareQuote={},X={},Button={},Popover={},PopoverContent={},PopoverTrigger={};' }))
    builder.onResolve({ filter: /api\/codexGateway$/ }, () => ({ path: 'gateway', namespace: 'gateway-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'gateway-stub' }, () => ({ contents: 'export const getInstalledPlugins=async()=>[],searchComposerFiles=async()=>[],uploadFile=async()=>({});' }))
  } }],
})
const source = compiled.outputFiles[0].text
  .replaceAll('from "vue"', `from '${import.meta.resolve('vue')}'`)
  .replaceAll('from "pinia"', `from '${import.meta.resolve('pinia')}'`)
const { default: Composer } = await import(`data:text/javascript;base64,${Buffer.from(source + '\n//# sourceURL=dictation-composer-fixture.mjs').toString('base64')}`)
const renderer = createRenderer({
  createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null,
})
const tick = () => new Promise(resolve => setImmediate(resolve))

function mockGlobal(t, key, descriptor) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { ...descriptor, configurable: true, writable: true })
  t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key] })
}

function fixture(t, { sendFails = false, noAudio = false } = {}) {
  let app
  t.after(() => app?.unmount())
  let resolveResponse
  let requests = 0
  let stoppedTracks = 0
  let recorder
  const sent = []
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Promise(resolve => { resolveResponse = resolve })
  })
  mockGlobal(t, 'navigator', { value: { userAgent: '', mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stoppedTracks++ }] }) } } })
  mockGlobal(t, 'document', { value: { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} } })
  mockGlobal(t, 'MediaRecorder', { value: class {
    state = 'inactive'
    mimeType = 'audio/webm'
    constructor() { recorder = this }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(noAudio ? [] : ['spoken audio'], { type: this.mimeType }) })
        this.onstop?.()
      })
    }
  } })
  const props = reactive({ activeThreadId: 'first', cwd: '', models: [], selectedModel: '', selectedReasoningEffort: '', submitMessage: async payload => {
    if (sendFails) throw new Error('Send failed')
    sent.push(payload)
  } })
  let composer
  app = renderer.createApp({ setup() {
    composer = Composer.setup(props, { expose() {}, emit() {} })
    return () => null
  } })
  app.use(createPinia())
  app.mount({})
  return {
    composer, props, sent, app,
    get requests() { return requests },
    get stoppedTracks() { return stoppedTracks },
    get recorder() { return recorder },
    async record() { composer.toggleDictation(); await tick(); assert.equal(composer.dictationState.value, 'recording') },
    async respond(text = 'spoken words', status = 200) {
      await tick()
      assert.ok(resolveResponse, 'transcription requested')
      resolveResponse(new Response(JSON.stringify({ text }), { status }))
      await tick(); await nextTick()
    },
  }
}

test('Send stops recording and submits the completed transcript with the existing draft once', async t => {
  const f = fixture(t)
  f.composer.draft.value = 'Typed introduction'
  f.composer.fileAttachments.value = [{ label: 'notes', path: 'notes.md', fsPath: 'notes.md' }]
  await f.record()
  assert.equal(f.composer.sendButtonLabel.value, 'Transcribe and send')
  const sending = f.composer.onSubmit('steer')
  assert.equal(f.recorder.state, 'inactive')
  assert.equal(f.composer.canSend.value, false)
  await f.composer.onSubmit('steer')
  assert.equal(f.sent.length, 0)
  await f.respond()
  await sending
  assert.equal(f.requests, 1)
  assert.equal(f.stoppedTracks, 1)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].text, 'Typed introduction\nspoken words')
  assert.equal(f.sent[0].fileAttachments.length, 1)
  assert.equal(f.sent[0].mode, 'steer')
  assert.equal(f.composer.draft.value, '')
})

test('voice-only Send works, including while manual Stop is already transcribing', async t => {
  const f = fixture(t)
  await f.record()
  assert.equal(f.composer.canSend.value, true)
  f.composer.stopRecording()
  const sending = f.composer.onSubmit()
  await f.respond()
  await sending
  assert.equal(f.sent[0].text, 'spoken words')
})

test('microphone Stop alone inserts a draft without sending', async t => {
  const f = fixture(t)
  await f.record()
  f.composer.stopRecording()
  await f.respond()
  assert.equal(f.sent.length, 0)
  assert.equal(f.composer.draft.value, 'spoken words')
})

for (const failure of ['http', 'empty']) test(`${failure} transcription preserves the draft and retry never retains send intent`, async t => {
  const f = fixture(t)
  f.composer.draft.value = 'Keep this'
  await f.record()
  const sending = f.composer.onSubmit()
  await f.respond('', failure === 'http' ? 503 : 200)
  await sending
  assert.equal(f.sent.length, 0)
  assert.equal(f.composer.draft.value, 'Keep this')
  assert.equal(f.composer.canRetryDictation.value, true)
  const retry = f.composer.retryTranscription()
  await f.respond('Recovered words')
  await retry
  assert.equal(f.sent.length, 0)
  assert.equal(f.composer.draft.value, 'Keep this\nRecovered words')
})

test('Cancel disarms sending and ignores even a late successful response', async t => {
  const f = fixture(t)
  f.composer.draft.value = 'Keep this'
  await f.record()
  const sending = f.composer.onSubmit()
  await tick()
  f.composer.cancelRecording()
  await sending
  await f.respond()
  assert.equal(f.sent.length, 0)
  assert.equal(f.composer.draft.value, 'Keep this')
})

test('switching away and back disarms sending and retains transcription in the original chat', async t => {
  const f = fixture(t)
  await f.record()
  const sending = f.composer.onSubmit()
  f.props.activeThreadId = 'second'
  await nextTick()
  assert.equal(f.composer.canSend.value, false)
  f.composer.draft.value = 'Other draft'
  f.props.activeThreadId = 'first'
  await f.respond()
  await sending
  assert.equal(f.sent.length, 0)
  assert.equal(f.composer.draft.value, 'spoken words')
  f.props.activeThreadId = 'second'
  assert.equal(f.composer.draft.value, 'Other draft')
})

test('a disabled destination at completion prevents sending', async t => {
  const f = fixture(t)
  await f.record()
  const sending = f.composer.onSubmit()
  f.props.sendDisabled = true
  await f.respond()
  await sending
  assert.equal(f.sent.length, 0)
  assert.equal(f.composer.draft.value, 'spoken words')
})

test('failed message submission preserves the completed draft for manual retry', async t => {
  const f = fixture(t, { sendFails: true })
  await f.record()
  const sending = f.composer.onSubmit()
  await f.respond()
  await sending
  assert.equal(f.composer.draft.value, 'spoken words')
  assert.equal(f.composer.submitError.value, 'Send failed')
  assert.equal(f.composer.canSend.value, true)
})


test('an empty recording never sends the typed draft', async t => {
  const f = fixture(t, { noAudio: true })
  f.composer.draft.value = 'Keep this'
  await f.record()
  await f.composer.onSubmit()
  assert.equal(f.requests, 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.composer.draft.value, 'Keep this')
  assert.match(f.composer.dictationError.value, /No audio/)
})

test('unmount cancels a pending send and ignores late transcription', async t => {
  const f = fixture(t)
  await f.record()
  const sending = f.composer.onSubmit()
  await tick()
  f.app.unmount()
  await sending
  await f.respond()
  assert.equal(f.sent.length, 0)
})
