<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const modelValue = defineModel<string>({ default: '' })
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    v-bind="$attrs"
    :class="cn(
      'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
      'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
      props.class,
    )"
  />
</template>
