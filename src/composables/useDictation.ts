import { computed, ref, onBeforeUnmount } from 'vue'
import { createScreenWakeLockController } from '../utils/screenWakeLock'

export type DictationState = 'idle' | 'recording' | 'transcribing'

export function useDictation(options: {
  onTranscript: (text: string) => void
  onError?: (error: unknown) => void
}) {
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
      void screenWakeLock.acquire()
    } catch (error) {
      if (currentOperationId !== operationId) return
      cleanup()
      errorMessage.value = error instanceof Error ? error.message : 'Could not open the microphone.'
      options.onError?.(error)
    } finally {
      isStarting.value = false
    }
  }

  function stopRecording() {
    if (state.value !== 'recording' || !mediaRecorder) return
    void screenWakeLock.release()
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
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
      const ext = mimeType.split(/[/;]/)[1] ?? 'webm'
      const boundary = `----codex-transcribe-${crypto.randomUUID()}`
      const fileBytes = new Uint8Array(await blob.arrayBuffer())
      const encoder = new TextEncoder()

      const parts: Uint8Array[] = []
      parts.push(encoder.encode(`--${boundary}\r\n`))
      parts.push(encoder.encode(`Content-Disposition: form-data; name="file"; filename="codex.${ext}"\r\n`))
      parts.push(encoder.encode(`Content-Type: ${mimeType}\r\n\r\n`))
      parts.push(fileBytes)
      parts.push(encoder.encode(`\r\n--${boundary}--\r\n`))

      let totalLen = 0
      for (const p of parts) totalLen += p.byteLength
      const body = new Uint8Array(totalLen)
      let offset = 0
      for (const p of parts) { body.set(p, offset); offset += p.byteLength }

      const response = await fetch('/codex-api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: controller.signal,
      })

      if (!response.ok) throw new Error(`Transcription failed: ${response.status}`)
      const data = (await response.json()) as { text?: string }
      const text = (data.text ?? '').trim()
      if (currentOperationId === operationId) {
        if (!text) throw new Error('No speech was recognized. Retry or record again.')
        options.onTranscript(text)
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

  function cleanup() {
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

  return { state, statusText, errorMessage, isStarting, canRetry, retryTranscription, isSupported, startRecording, stopRecording, cancelRecording }
}
