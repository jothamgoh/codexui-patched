import { computed, ref, onBeforeUnmount, watch } from 'vue'
import { createScreenWakeLockController } from '../utils/screenWakeLock'

export type DictationState = 'idle' | 'recording' | 'transcribing'

/** The recording as the multipart body the transcription proxy and the voice command route both take. */
export type DictationAudio = { body: Uint8Array<ArrayBuffer>; contentType: string }

type DictationOptions<T> = {
  onTranscript: (value: T) => void
  onError?: (error: unknown) => void
  /** Measure the input level while recording, for a level meter. */
  meter?: boolean
}

/**
 * Records from the microphone, then uploads the recording. By default the
 * upload is the transcription proxy and the result is the text; `upload`
 * sends the same recording somewhere else and returns what that gives back.
 */
export function useDictation(options: DictationOptions<string>): ReturnType<typeof createDictation>
export function useDictation<T>(options: DictationOptions<T> & { upload: (audio: DictationAudio, signal: AbortSignal) => Promise<T> }): ReturnType<typeof createDictation>
export function useDictation<T>(options: DictationOptions<T> & { upload?: (audio: DictationAudio, signal: AbortSignal) => Promise<T> }) {
  return createDictation(options as DictationOptions<T>, options.upload ?? (transcribeAudio as unknown as (audio: DictationAudio, signal: AbortSignal) => Promise<T>))
}

/** The transcription proxy: the recognised text, or an error when nothing was recognised. */
async function transcribeAudio(audio: DictationAudio, signal: AbortSignal): Promise<string> {
  const response = await fetch('/codex-api/transcribe', { method: 'POST', headers: { 'Content-Type': audio.contentType }, body: audio.body, signal })
  if (!response.ok) throw new Error(`Transcription failed: ${response.status}`)
  const data = (await response.json()) as { text?: string }
  const text = (data.text ?? '').trim()
  if (!text) throw new Error('No speech was recognized. Retry or record again.')
  return text
}

async function encodeRecording(blob: Blob, mimeType: string): Promise<DictationAudio> {
  const ext = mimeType.split(/[/;]/)[1] ?? 'webm'
  const boundary = `----codex-transcribe-${crypto.randomUUID()}`
  const fileBytes = new Uint8Array(await blob.arrayBuffer())
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [
    encoder.encode(`--${boundary}\r\n`),
    encoder.encode(`Content-Disposition: form-data; name="file"; filename="codex.${ext}"\r\n`),
    encoder.encode(`Content-Type: ${mimeType}\r\n\r\n`),
    fileBytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ]
  const body = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) { body.set(part, offset); offset += part.byteLength }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

function createDictation<T>(options: DictationOptions<T>, upload: (audio: DictationAudio, signal: AbortSignal) => Promise<T>) {
  const state = ref<DictationState>('idle')
  const errorMessage = ref('')
  const isStarting = ref(false)
  const hasTranscript = ref(false)
  const statusText = computed(() => errorMessage.value || (isStarting.value ? 'Opening microphone…'
    : state.value === 'recording' ? 'Recording… Stop when you’re ready.'
    : state.value === 'transcribing' ? 'Transcribing…'
    : hasTranscript.value ? 'Ready — review your words before sending.' : ''))
  const canRetry = ref(false)
  let retryRecording: { chunks: Blob[]; mimeType: string } | null = null
  const isSupported = ref(typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia)
  /** Input level, 0 to 1, while recording with `meter`. */
  const level = ref(0)
  let stopMeter: (() => void) | null = null

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let transcriptionController: AbortController | null = null
  let chunks: Blob[] = []
  let operationId = 0
  const screenWakeLock = createScreenWakeLockController()

  async function startRecording() {
    if (state.value !== 'idle' || isStarting.value || !isSupported.value) return
    isStarting.value = true
    errorMessage.value = ''
    hasTranscript.value = false
    canRetry.value = false
    retryRecording = null
    const currentOperationId = operationId
    try {
      const requestedStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
      if (currentOperationId !== operationId) {
        requestedStream.getTracks().forEach((track) => track.stop())
        return
      }
      mediaStream = requestedStream
      chunks = []
      mediaRecorder = new MediaRecorder(mediaStream)
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      mediaRecorder.onstop = () => {
        const recordedChunks = chunks
        const recordedMimeType = mediaRecorder?.mimeType || recordedChunks[0]?.type || 'audio/webm'
        cleanup()
        void transcribe(recordedChunks, recordedMimeType)
      }
      mediaRecorder.start()
      state.value = 'recording'
      if (options.meter) stopMeter = startMeter(requestedStream)
      void screenWakeLock.acquire()
    } catch (error) {
      if (currentOperationId !== operationId) return
      cleanup()
      errorMessage.value = error instanceof Error ? error.message : 'Could not open the microphone.'
      options.onError?.(error)
    } finally {
      if (currentOperationId === operationId) isStarting.value = false
    }
  }

  function stopRecording() {
    if (state.value !== 'recording' || !mediaRecorder) return
    state.value = 'transcribing'
    void screenWakeLock.release()
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
  }

  function finishRecording(): Promise<boolean> {
    if (state.value === 'idle') return Promise.resolve(false)
    return new Promise((resolve) => {
      const stopWatching = watch(state, (value) => {
        if (value !== 'idle') return
        stopWatching()
        resolve(hasTranscript.value && !errorMessage.value)
      }, { flush: 'sync' })
      stopRecording()
    })
  }

  async function transcribe(recordedChunks: Blob[], mimeType: string) {
    if (recordedChunks.length === 0) {
      errorMessage.value = 'No audio was recorded. Try recording again.'
      state.value = 'idle'
      return
    }

    state.value = 'transcribing'
    errorMessage.value = ''
    canRetry.value = false
    retryRecording = { chunks: recordedChunks, mimeType }
    const blob = new Blob(recordedChunks, { type: mimeType })
    const currentOperationId = operationId
    const controller = new AbortController()
    transcriptionController = controller

    try {
      const value = await upload(await encodeRecording(blob, mimeType), controller.signal)
      if (currentOperationId === operationId) {
        options.onTranscript(value)
        hasTranscript.value = true
        retryRecording = null
      }
    } catch (error) {
      if (currentOperationId !== operationId) return
      if (!(error instanceof Error && error.name === 'AbortError')) {
        errorMessage.value = error instanceof Error ? error.message : 'Could not transcribe audio.'
        canRetry.value = retryRecording !== null
        options.onError?.(error)
      }
    } finally {
      if (transcriptionController === controller) {
        transcriptionController = null
        if (state.value === 'transcribing') state.value = 'idle'
      }
    }
  }

  function retryTranscription() {
    if (state.value !== 'idle' || !retryRecording) return
    return transcribe(retryRecording.chunks, retryRecording.mimeType)
  }

  function cancelRecording() {
    operationId += 1
    isStarting.value = false
    retryRecording = null
    canRetry.value = false
    errorMessage.value = ''
    hasTranscript.value = false
    const recorder = mediaRecorder
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') recorder.stop()
    }
    cleanup()
    transcriptionController?.abort()
    transcriptionController = null
    state.value = 'idle'
  }

  /** Follows the microphone's loudness; any failure just leaves the level at 0. */
  function startMeter(stream: MediaStream): (() => void) | null {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return null
    try {
      const context = new AudioContextClass()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      let frame = 0
      const tick = () => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        level.value = Math.min(1, Math.sqrt(sum / samples.length) * 4)
        frame = requestAnimationFrame(tick)
      }
      tick()
      return () => {
        cancelAnimationFrame(frame)
        level.value = 0
        void context.close().catch(() => undefined)
      }
    } catch {
      return null
    }
  }

  function cleanup() {
    stopMeter?.()
    stopMeter = null
    void screenWakeLock.release()
    if (mediaRecorder) {
      mediaRecorder.ondataavailable = null
      mediaRecorder.onstop = null
      mediaRecorder = null
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
      mediaStream = null
    }
    chunks = []
  }

  onBeforeUnmount(cancelRecording)

  return { state, statusText, errorMessage, isStarting, canRetry, retryTranscription, isSupported, level, startRecording, stopRecording, finishRecording, cancelRecording }
}
