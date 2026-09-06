<script setup lang="ts">
import Button from '../ui/button/Button.vue'

defineOptions({ inheritAttrs: false })
defineProps<{ failed?: boolean }>()

function refreshApp(): void {
  window.location.reload()
}
</script>

<template>
  <section class="screen-load-state" :role="failed ? 'alert' : 'status'">
    <template v-if="failed">
      <h2>This screen couldn’t load</h2>
      <p>Your connection may have dropped, or the app was updated. Refresh to try again.</p>
      <Button type="button" @click="refreshApp">Refresh app</Button>
    </template>
    <p v-else>Opening this screen…</p>
  </section>
</template>

<style scoped>
@reference "../../style.css";
.screen-load-state { @apply min-h-0 flex-1 overflow-y-auto p-6 text-center text-foreground; }
h2 { @apply mx-auto mt-8 max-w-sm text-lg font-semibold; }
p { @apply mx-auto my-4 max-w-sm text-sm leading-6 text-muted-foreground; }
button { @apply min-h-11; }
</style>
