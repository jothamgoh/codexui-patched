<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectBoardRun } from '../../types/projectBoards'
const props = defineProps<{ run?: ProjectBoardRun }>()
const confirmed = computed(() => Boolean(props.run?.observedModel && props.run?.observedReasoningEffort))
const model = computed(() => confirmed.value ? props.run?.observedModel : props.run?.requestedModel)
const effort = computed(() => confirmed.value ? props.run?.observedReasoningEffort : props.run?.requestedReasoningEffort)
const label = computed(() => ['running', 'queued'].includes(props.run?.status || '') ? 'This run' : 'Last run')
</script>

<template>
  <p v-if="model" class="run-settings" data-testid="board-run-settings">
    {{ label }}: <strong>{{ model }}</strong><template v-if="effort"> · {{ effort === 'xhigh' ? 'Extra high' : effort }} reasoning</template>
    <span> · {{ confirmed ? 'Confirmed by Codex' : 'Requested' }}</span>
  </p>
</template>

<style scoped>
.run-settings { margin: .5rem 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere; white-space: normal; }
strong { font-weight: 500; color: var(--text-primary); }
span { color: var(--text-tertiary); }
</style>
