<template>
  <span class="background-work-mark" aria-hidden="true"><span class="background-work-mark-dot" /></span>
</template>

<!--
  Claude background work that outlived its reply. Unlike the turn spinner it
  stays still, so a chat that only waits on a monitor or a background command
  does not look like it is still replying.
-->

<style scoped>
@reference "tailwindcss";

.background-work-mark {
  @apply inline-flex size-2.5 shrink-0 items-center justify-center rounded-full;
  border: 1.5px solid currentColor;
}

.background-work-mark-dot {
  @apply size-1 rounded-full;
  background: currentColor;
  animation: background-work-breathe 2.4s ease-in-out infinite;
}

@keyframes background-work-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

@media (prefers-reduced-motion: reduce) {
  .background-work-mark-dot { animation: none; }
}
</style>
