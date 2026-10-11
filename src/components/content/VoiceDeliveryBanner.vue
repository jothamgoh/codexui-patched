<template>
  <section class="voice-delivery" :class="`is-${copy.tone}`" role="region" aria-label="Voice send">
    <div v-if="copy.tone === 'counting'" class="voice-delivery-bar" aria-hidden="true">
      <span :style="{ transform: `scaleX(${fractionLeft})` }" />
    </div>
    <div class="voice-delivery-body">
      <div class="voice-delivery-icon" aria-hidden="true">
        <LoaderCircle v-if="copy.tone === 'sending'" class="is-spinning" />
        <CheckCircle2 v-else-if="copy.tone === 'done'" />
        <span v-else-if="copy.tone === 'counting'" class="voice-delivery-count">{{ seconds }}</span>
        <Mic v-else />
      </div>
      <div class="voice-delivery-copy">
        <p class="voice-delivery-title" aria-live="polite">{{ liveTitle }}</p>
        <p v-if="copy.detail" class="voice-delivery-detail">{{ copy.detail }}</p>
        <p v-if="error" class="voice-delivery-error" role="alert">{{ error }}</p>
      </div>
      <button v-if="copy.tone === 'done' || copy.tone === 'problem'" class="voice-delivery-dismiss" type="button" aria-label="Dismiss" @click="emit('dismiss')">
        <X aria-hidden="true" />
      </button>
    </div>
    <div v-if="copy.tone === 'counting'" class="voice-delivery-actions">
      <button class="voice-delivery-cancel" type="button" :disabled="busy" @click="void stop(false)">Cancel</button>
      <button class="voice-delivery-edit" type="button" :disabled="busy" @click="void stop(true)">Edit</button>
    </div>
    <div v-else-if="copy.tone === 'done' && openThreadId" class="voice-delivery-actions">
      <button class="voice-delivery-cancel" type="button" @click="emit('open', openThreadId)">Open chat</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { CheckCircle2, LoaderCircle, Mic, X } from '@lucide/vue'
import { useVoiceDelivery } from '../../composables/useVoiceDelivery'
import type { VoiceStoredResult } from '../../types/voice'
import { describeDelivery } from '../../utils/voiceDelivery'

/**
 * A spoken send the server is doing: the countdown with Cancel (the main
 * control) and Edit, then "Sent ✓". Cancel and Edit stop the send and hand
 * the message back to be typed in; Edit also focuses it.
 */
const props = withDefaults(defineProps<{ openChat?: boolean }>(), { openChat: false })
const result = defineModel<VoiceStoredResult>('result', { required: true })
const emit = defineEmits<{
  /** The send was stopped in time; type the message in. */
  (event: 'stopped', payload: { result: VoiceStoredResult; edit: boolean }): void
  (event: 'open', threadId: string): void
  (event: 'dismiss'): void
}>()

const { seconds, fractionLeft, cancel } = useVoiceDelivery(result)

const busy = ref(false)
const error = ref('')
const delivery = computed(() => result.value.delivery)
const copy = computed(() => (delivery.value ? describeDelivery(delivery.value, seconds.value) : { title: '', detail: '', tone: 'done' as const }))
/** The count changes every second; screen readers hear the line once, without the number. */
const liveTitle = computed(() => copy.value.title)
const openThreadId = computed(() => (props.openChat && delivery.value?.kind === 'new_chat' ? delivery.value.threadId ?? '' : ''))

async function stop(edit: boolean): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const answer = await cancel()
    if (answer?.delivery?.state === 'cancelled') emit('stopped', { result: answer, edit })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Could not cancel.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.voice-delivery { position: relative; overflow: hidden; margin: 0 auto 8px; width: 100%; max-width: 880px; border: 1px solid var(--accent-soft); border-radius: 12px; background: var(--accent-soft); color: var(--text-primary); }
.voice-delivery.is-problem { border-color: rgb(229 72 77 / 40%); background: rgb(229 72 77 / 10%); }
.voice-delivery-bar { position: absolute; inset: 0 0 auto; height: 3px; background: transparent; }
.voice-delivery-bar span { display: block; height: 100%; background: var(--accent); transform-origin: left center; transition: transform 200ms linear; }
.voice-delivery-body { display: flex; align-items: flex-start; gap: 10px; padding: 12px 12px 4px; }
.voice-delivery-icon { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; border-radius: 999px; background: var(--surface-elevated); color: var(--accent); }
.voice-delivery-icon svg { width: 18px; height: 18px; }
.voice-delivery-icon .is-spinning { animation: voice-delivery-spin 900ms linear infinite; }
.voice-delivery-count { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
.voice-delivery-copy { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.voice-delivery-title { font-size: 15px; font-weight: 600; line-height: 20px; }
.voice-delivery-detail { margin-top: 2px; font-size: 13px; line-height: 18px; color: var(--text-secondary); }
.voice-delivery-error { margin-top: 4px; font-size: 13px; color: #e5484d; }
.voice-delivery-dismiss { display: grid; place-items: center; width: 44px; height: 44px; margin: -8px -8px -8px 0; border-radius: 10px; color: var(--text-muted); background: none; cursor: pointer; flex-shrink: 0; }
.voice-delivery-dismiss svg { width: 16px; height: 16px; }
.voice-delivery-actions { display: flex; gap: 8px; padding: 8px 12px 12px 54px; }
.voice-delivery-cancel, .voice-delivery-edit { min-height: 44px; padding: 0 18px; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
.voice-delivery-cancel { flex: 1; max-width: 240px; background: var(--accent); color: #fff; border: 1px solid var(--accent); }
.voice-delivery-edit { background: var(--surface-elevated); color: var(--text-primary); border: 1px solid var(--border-strong); }
.voice-delivery-cancel:disabled, .voice-delivery-edit:disabled { opacity: 0.6; cursor: default; }
.voice-delivery button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@keyframes voice-delivery-spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .voice-delivery-actions { padding-left: 12px; }
  .voice-delivery-cancel { max-width: none; }
}
</style>
