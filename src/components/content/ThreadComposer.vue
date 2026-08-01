<template>
  <form class="thread-composer" @submit.prevent="onSubmit('steer')">
    <div class="thread-composer-shell" :class="{ 'thread-composer-shell--no-top-radius': hasQueueAbove }">
      <div v-if="responseTextAnnotations.length > 0" class="thread-composer-response-annotations">
        <Popover>
          <PopoverTrigger as-child>
            <button class="thread-composer-response-annotations-trigger" type="button">
              <MessageSquareQuote class="thread-composer-response-annotations-trigger-icon" />
              <span>{{ selectionCountLabel(responseTextAnnotations.length) }}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            class="thread-composer-response-annotations-popover"
            align="start"
            side="top"
            :side-offset="8"
          >
            <div class="thread-composer-response-annotations-header">
              <span>Added from responses</span>
              <span>{{ responseTextAnnotations.length }}</span>
            </div>
            <div class="thread-composer-response-annotations-list">
              <blockquote
                v-for="annotation in responseTextAnnotations"
                :key="annotation.id"
                class="thread-composer-response-annotation"
              >
                <div class="thread-composer-response-annotation-content">
                  <p class="thread-composer-response-annotation-quote">{{ annotation.text }}</p>
                  <p v-if="annotation.annotation" class="thread-composer-response-annotation-comment">
                    {{ annotation.annotation }}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  class="thread-composer-response-annotation-remove"
                  :aria-label="`Remove selection: ${annotation.text.slice(0, 40)}`"
                  @click="removeResponseAnnotation(annotation.id)"
                >
                  <X />
                </Button>
              </blockquote>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div v-if="selectedImages.length > 0" class="thread-composer-attachments">
        <div v-for="image in selectedImages" :key="image.id" class="thread-composer-attachment">
          <img class="thread-composer-attachment-image" :src="image.url" :alt="image.name || 'Selected image'" />
          <button
            class="thread-composer-attachment-remove"
            type="button"
            :aria-label="`Remove ${image.name || 'image'}`"
            :disabled="isInteractionDisabled"
            @click="removeImage(image.id)"
          >
            x
          </button>
        </div>
      </div>

      <div v-if="detachedFileAttachments.length > 0" class="thread-composer-file-chips">
        <span v-for="att in detachedFileAttachments" :key="att.fsPath" class="thread-composer-file-chip">
          <IconTablerFilePencil class="thread-composer-file-chip-icon" />
          <span class="thread-composer-file-chip-name" :title="att.fsPath">{{ att.label }}</span>
          <button
            class="thread-composer-file-chip-remove"
            type="button"
            :aria-label="`Remove ${att.label}`"
            :disabled="isInteractionDisabled"
            @click="removeFileAttachment(att.fsPath)"
          >×</button>
        </span>
      </div>

      <div v-if="selectedSkills.length > 0" class="thread-composer-skill-chips">
        <span v-for="skill in selectedSkills" :key="skill.path" class="thread-composer-skill-chip">
          <span class="thread-composer-skill-chip-name">{{ skill.name }}</span>
          <button
            class="thread-composer-skill-chip-remove"
            type="button"
            :aria-label="`Remove skill ${skill.name}`"
            @click="removeSkill(skill.path)"
          >×</button>
        </span>
      </div>

      <div v-if="selectedPlugins.length > 0" class="thread-composer-plugin-chips">
        <span v-for="plugin in selectedPlugins" :key="plugin.id" class="thread-composer-plugin-chip">
          <Blocks class="thread-composer-plugin-chip-icon" aria-hidden="true" />
          <span class="thread-composer-plugin-chip-name">{{ plugin.displayName }}</span>
          <button
            class="thread-composer-plugin-chip-remove"
            type="button"
            :aria-label="`Remove plugin ${plugin.displayName}`"
            @click="removePlugin(plugin.id)"
          >×</button>
        </span>
      </div>

      <div v-if="selectedThreads.length > 0" class="thread-composer-thread-chips">
        <span v-for="thread in selectedThreads" :key="thread.id" class="thread-composer-thread-chip">
          <MessageSquare class="thread-composer-thread-chip-icon" aria-hidden="true" />
          <span class="thread-composer-thread-chip-name">{{ thread.name }}</span>
          <button
            class="thread-composer-thread-chip-remove"
            type="button"
            :aria-label="`Remove chat ${thread.name}`"
            @click="removeThreadMention(thread.id)"
          >×</button>
        </span>
      </div>

      <div v-if="goal || isGoalEditorOpen" class="thread-composer-goal-card">
        <div class="thread-composer-goal-header">
          <div class="thread-composer-goal-summary">
            <span class="thread-composer-goal-badge">Goal</span>
            <span v-if="goalStatusSummary" class="thread-composer-goal-status">{{ goalStatusSummary }}</span>
            <span v-if="goalProgressSummary" class="thread-composer-goal-progress">{{ goalProgressSummary }}</span>
          </div>
          <div class="thread-composer-goal-actions">
            <button
              v-if="goal && goal.status === 'active'"
              class="thread-composer-goal-action"
              type="button"
              :disabled="isInteractionDisabled"
              @click="emitGoalStatusUpdate('paused')"
            >
              Pause
            </button>
            <button
              v-else-if="goal"
              class="thread-composer-goal-action"
              type="button"
              :disabled="isInteractionDisabled"
              @click="emitGoalStatusUpdate('active')"
            >
              Resume
            </button>
            <button
              v-if="goal"
              class="thread-composer-goal-action"
              type="button"
              :disabled="isInteractionDisabled"
              @click="openGoalEditor(goal.objective)"
            >
              Edit
            </button>
            <button
              v-if="goal"
              class="thread-composer-goal-action thread-composer-goal-action--danger"
              type="button"
              :disabled="isInteractionDisabled"
              @click="emit('clear-goal')"
            >
              Clear
            </button>
          </div>
        </div>

        <template v-if="isGoalEditorOpen">
          <textarea
            ref="goalInputRef"
            v-model="goalDraft"
            class="thread-composer-goal-input"
            rows="3"
            placeholder="Set a goal Codex should keep working on..."
            :disabled="isInteractionDisabled"
            @keydown="onGoalInputKeydown"
          />
          <div class="thread-composer-goal-editor-actions">
            <button
              class="thread-composer-goal-save"
              type="button"
              :disabled="isInteractionDisabled || goalDraft.trim().length === 0"
              @click="saveGoal"
            >
              Save
            </button>
            <button
              class="thread-composer-goal-cancel"
              type="button"
              :disabled="isInteractionDisabled"
              @click="closeGoalEditor"
            >
              Cancel
            </button>
          </div>
        </template>

        <template v-else-if="goal">
          <p class="thread-composer-goal-objective" :class="{ 'is-collapsed': !isGoalObjectiveExpanded }">
            {{ goal.objective }}
          </p>
          <button
            v-if="shouldShowGoalExpand"
            class="thread-composer-goal-expand"
            type="button"
            @click="isGoalObjectiveExpanded = !isGoalObjectiveExpanded"
          >
            {{ isGoalObjectiveExpanded ? 'Hide full goal' : 'Show full goal' }}
          </button>
        </template>
      </div>

      <div class="thread-composer-input-wrap">
        <div
          v-if="isFileMentionOpen"
          class="thread-composer-file-mentions"
          role="listbox"
          aria-label="Composer mentions"
        >
          <template v-if="composerMentionSuggestions.length > 0">
            <template v-if="pluginMentionSuggestions.length > 0">
              <div class="thread-composer-file-mention-section">Plugins</div>
              <button
                v-for="(plugin, index) in pluginMentionSuggestions"
                :key="plugin.path"
                class="thread-composer-file-mention-row"
                :class="{ 'is-active': index === fileMentionHighlightedIndex }"
                type="button"
                role="option"
                :aria-selected="index === fileMentionHighlightedIndex"
                @mousedown.prevent="applyPluginMention(plugin)"
              >
                <Blocks class="thread-composer-file-mention-plugin-icon" aria-hidden="true" />
                <span class="thread-composer-file-mention-text">
                  <span class="thread-composer-file-mention-name">{{ plugin.displayName }}</span>
                  <span v-if="plugin.description" class="thread-composer-file-mention-dir">
                    {{ plugin.description }}
                  </span>
                </span>
                <Check
                  v-if="selectedPluginIds.has(plugin.id)"
                  class="thread-composer-file-mention-check"
                  aria-hidden="true"
                />
              </button>
            </template>
            <template v-if="threadMentionSuggestions.length > 0">
              <div class="thread-composer-file-mention-section">Chats</div>
              <button
                v-for="(thread, index) in threadMentionSuggestions"
                :key="thread.path"
                class="thread-composer-file-mention-row"
                :class="{ 'is-active': pluginMentionSuggestions.length + index === fileMentionHighlightedIndex }"
                type="button"
                role="option"
                :aria-selected="pluginMentionSuggestions.length + index === fileMentionHighlightedIndex"
                @mousedown.prevent="applyThreadMention(thread)"
              >
                <MessageSquare class="thread-composer-file-mention-plugin-icon" aria-hidden="true" />
                <span class="thread-composer-file-mention-text">
                  <span class="thread-composer-file-mention-name">{{ thread.name }}</span>
                </span>
                <Check
                  v-if="selectedThreadMentionIds.has(thread.id)"
                  class="thread-composer-file-mention-check"
                  aria-hidden="true"
                />
              </button>
            </template>
            <div v-if="fileMentionSuggestions.length > 0" class="thread-composer-file-mention-section">
              Files
            </div>
            <button
              v-for="(item, index) in fileMentionSuggestions"
              :key="item.path"
              class="thread-composer-file-mention-row"
              :class="{ 'is-active': pluginMentionSuggestions.length + threadMentionSuggestions.length + index === fileMentionHighlightedIndex }"
              type="button"
              role="option"
              :aria-selected="pluginMentionSuggestions.length + threadMentionSuggestions.length + index === fileMentionHighlightedIndex"
              @mousedown.prevent="applyFileMention(item)"
            >
              <span
                v-if="getMentionBadgeText(item.path)"
                class="thread-composer-file-mention-icon-badge"
                :class="`is-${getMentionBadgeClass(item.path)}`"
              >
                {{ getMentionBadgeText(item.path) }}
              </span>
              <span v-else-if="isMarkdownFile(item.path)" class="thread-composer-file-mention-icon-markdown">↓</span>
              <IconTablerFilePencil v-else class="thread-composer-file-mention-icon-file" />
              <span class="thread-composer-file-mention-text">
                <span class="thread-composer-file-mention-name">{{ getMentionFileName(item.path) }}</span>
                <span v-if="getMentionDirName(item.path)" class="thread-composer-file-mention-dir">{{ getMentionDirName(item.path) }}</span>
              </span>
            </button>
          </template>
          <div v-else class="thread-composer-file-mention-empty">No matching plugins, chats, or files</div>
        </div>
        <textarea
          ref="inputRef"
          v-model="draft"
          class="thread-composer-input"
          rows="1"
          :placeholder="placeholderText"
          :disabled="isInteractionDisabled"
          @input="onInputChange"
          @focus="onInputFocus"
          @keydown="onInputKeydown"
          @paste="onInputPaste"
        />
        <ComposerSkillPicker
          :skills="skillOptions"
          :visible="isSlashMenuOpen"
          :anchor-bottom="44"
          :anchor-left="0"
          @select="onSlashSkillSelect"
          @close="closeSlashMenu"
        />
      </div>

      <div class="thread-composer-controls">
        <div class="thread-composer-option-strip">
          <div ref="attachMenuRootRef" class="thread-composer-attach">
            <button
              class="thread-composer-attach-trigger"
              type="button"
              aria-label="Add photos & files"
              :disabled="isInteractionDisabled"
              @click="toggleAttachMenu"
            >
              +
            </button>

            <div
              v-if="isAttachMenuOpen"
              class="thread-composer-attach-menu"
            >
              <button
                class="thread-composer-attach-item"
                type="button"
                :disabled="isInteractionDisabled"
                @click="triggerPhotoLibrary"
              >
                Add photos & files
              </button>
              <button
                class="thread-composer-attach-item"
                type="button"
                :disabled="isInteractionDisabled"
                @click="triggerCameraCapture"
              >
                Take photo
              </button>
            </div>
          </div>

          <ComposerDropdown
            class="thread-composer-control thread-composer-control--model"
            :model-value="selectedModel"
            :options="modelOptions"
            placeholder="Model"
            open-direction="up"
            :disabled="disabled || !activeThreadId || models.length === 0 || isTurnInProgress"
            @update:model-value="onModelSelect"
          />

          <ComposerSearchDropdown
            class="thread-composer-control thread-composer-control--skills"
            :options="skillDropdownOptions"
            :selected-values="selectedSkillPaths"
            placeholder="Skills"
            search-placeholder="Search skills..."
            open-direction="up"
            :disabled="disabled || !activeThreadId || isTurnInProgress || (skills ?? []).length === 0"
            @toggle="onSkillDropdownToggle"
          />

          <ComposerDropdown
            class="thread-composer-control thread-composer-control--reasoning"
            :model-value="selectedReasoningEffort"
            :options="reasoningOptions"
            placeholder="Thinking"
            open-direction="up"
            :disabled="disabled || !activeThreadId || isTurnInProgress"
            @update:model-value="onReasoningEffortSelect"
          />
        </div>

        <div
          v-if="shouldShowContextUsageIndicator"
          class="thread-composer-context-usage"
          :aria-label="contextUsageAriaLabel"
          :title="contextUsageTooltip"
        >
          <span
            class="thread-composer-context-usage-ring"
            :class="contextUsageToneClass"
            :style="{ '--context-usage-angle': contextUsageAngle }"
            aria-hidden="true"
          >
            <span class="thread-composer-context-usage-ring-core" />
          </span>
        </div>

        <span class="thread-composer-separator" />

        <div class="thread-composer-actions">
          <button
            v-if="isDictationSupported"
            class="thread-composer-mic"
            :class="{
              'thread-composer-mic--recording': dictationState === 'recording',
              'thread-composer-mic--transcribing': dictationState === 'transcribing',
            }"
            type="button"
            :aria-label="dictationButtonLabel"
            :aria-pressed="dictationState === 'recording'"
            :title="dictationButtonLabel"
            :disabled="isInteractionDisabled || dictationState === 'transcribing'"
            @click="toggleDictation"
          >
            <span v-if="dictationState === 'transcribing'" class="thread-composer-mic-spinner" aria-hidden="true" />
            <IconTablerMicrophone v-else class="thread-composer-mic-icon" />
          </button>

          <button
            v-if="isTurnInProgress"
            class="thread-composer-stop"
            type="button"
            aria-label="Stop"
            title="Stop"
            :disabled="disabled || !activeThreadId || isInterruptingTurn"
            @click="onInterrupt"
          >
            <IconTablerPlayerStopFilled class="thread-composer-stop-icon" />
          </button>

          <button
            class="thread-composer-submit"
            type="button"
            :aria-label="isTurnInProgress ? 'Send steering message' : 'Send message'"
            :title="isTurnInProgress ? 'Steer' : 'Send'"
            :disabled="!canSubmit"
            @click="onSubmit('steer')"
          >
            <IconTablerArrowUp class="thread-composer-submit-icon" />
          </button>
        </div>
      </div>
    </div>
    <input
      ref="photoLibraryInputRef"
      class="thread-composer-hidden-input"
      type="file"
      multiple
      :disabled="isInteractionDisabled"
      @change="onPhotoLibraryChange"
    />
    <input
      ref="cameraCaptureInputRef"
      class="thread-composer-hidden-input"
      type="file"
      accept="image/*"
      capture="environment"
      :disabled="isInteractionDisabled"
      @change="onCameraCaptureChange"
    />
    <Teleport to="body">
      <div
        v-if="pendingGoalReplacementObjective.length > 0"
        class="thread-composer-goal-modal-backdrop"
        @click.self="cancelGoalReplacement"
      >
        <form class="thread-composer-goal-modal" @submit.prevent="confirmGoalReplacement">
          <div class="thread-composer-goal-modal-header">
            <h3 class="thread-composer-goal-modal-title">Replace current goal?</h3>
            <p class="thread-composer-goal-modal-copy">
              This will keep the thread but replace the saved goal with your current composer text.
            </p>
          </div>
          <p class="thread-composer-goal-modal-preview">{{ pendingGoalReplacementObjective }}</p>
          <div class="thread-composer-goal-modal-actions">
            <button class="thread-composer-goal-modal-cancel" type="button" @click="cancelGoalReplacement">
              Cancel
            </button>
            <button class="thread-composer-goal-modal-confirm" type="submit">
              Replace goal
            </button>
          </div>
        </form>
      </div>
    </Teleport>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Blocks, Check, MessageSquare, MessageSquareQuote, X } from '@lucide/vue'
import type {
  ReasoningEffort,
  ResponseTextAnnotation,
  ThreadGoalStatus,
  UiThreadGoal,
  UiThreadTokenUsage,
} from '../../types/codex'
import { useDictation } from '../../composables/useDictation'
import { useResponseAnnotations } from '../../composables/useResponseAnnotations'
import {
  getInstalledPlugins,
  searchComposerFiles,
  uploadFile,
  type ComposerFileSuggestion,
  type PluginMentionParam,
  type ThreadMentionParam,
} from '../../api/codexGateway'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import IconTablerArrowUp from '../icons/IconTablerArrowUp.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerMicrophone from '../icons/IconTablerMicrophone.vue'
import IconTablerPlayerStopFilled from '../icons/IconTablerPlayerStopFilled.vue'
import ComposerDropdown from './ComposerDropdown.vue'
import ComposerSearchDropdown from './ComposerSearchDropdown.vue'
import ComposerSkillPicker from './ComposerSkillPicker.vue'

type SkillItem = { name: string; description: string; path: string }
const GOAL_SLASH_COMMAND_PATH = '__codex-command:goal'
const GOAL_SLASH_COMMAND_PATTERN = /^\/go+al(?:\s+.*)?$/iu
const GOAL_SLASH_COMMAND_PREFIX_PATTERN = /^\/go+al\b/iu
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const props = defineProps<{
  activeThreadId: string
  cwd?: string
  models: string[]
  selectedModel: string
  selectedReasoningEffort: ReasoningEffort | ''
  skills?: SkillItem[]
  threads?: ThreadMentionParam[]
  threadTokenUsage?: UiThreadTokenUsage | null
  showContextUsage?: boolean
  goal?: UiThreadGoal | null
  isTurnInProgress?: boolean
  isInterruptingTurn?: boolean
  turnActivityLabel?: string
  disabled?: boolean
  hasQueueAbove?: boolean
}>()

export type FileAttachment = { label: string; path: string; fsPath: string }

export type SubmitPayload = {
  text: string
  imageUrls: string[]
  fileAttachments: FileAttachment[]
  responseTextAnnotations: ResponseTextAnnotation[]
  skills: Array<{ name: string; path: string }>
  plugins: PluginMentionParam[]
  threads: ThreadMentionParam[]
  mode: 'steer' | 'queue'
}

const emit = defineEmits<{
  submit: [payload: SubmitPayload]
  interrupt: []
  'set-goal': [payload: { objective: string }]
  'clear-goal': []
  'update-goal-status': [payload: { status: ThreadGoalStatus }]
  'update:selected-model': [modelId: string]
  'update:selected-reasoning-effort': [effort: ReasoningEffort | '']
}>()

type SelectedImage = {
  id: string
  name: string
  url: string
}

const draft = ref('')
const selectedImages = ref<SelectedImage[]>([])
const selectedSkills = ref<SkillItem[]>([])
const installedPlugins = ref<PluginMentionParam[]>([])
const selectedPlugins = ref<PluginMentionParam[]>([])
const selectedThreads = ref<ThreadMentionParam[]>([])
const fileAttachments = ref<FileAttachment[]>([])
const mentionedFilePaths = ref<Set<string>>(new Set())
const { responseTextAnnotations } = useResponseAnnotations()

const { state: dictationState, isSupported: isDictationSupported, startRecording, stopRecording } = useDictation({
  onTranscript: (text) => { draft.value = draft.value ? `${draft.value}\n${text}` : text },
})
const attachMenuRootRef = ref<HTMLElement | null>(null)
const photoLibraryInputRef = ref<HTMLInputElement | null>(null)
const cameraCaptureInputRef = ref<HTMLInputElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const goalInputRef = ref<HTMLTextAreaElement | null>(null)
const isAttachMenuOpen = ref(false)
const isLoadingPlugins = ref(false)
const pluginLoadError = ref('')
const isSlashMenuOpen = ref(false)
const isGoalEditorOpen = ref(false)
const goalDraft = ref('')
const isGoalObjectiveExpanded = ref(false)
const pendingGoalReplacementObjective = ref('')
const goalProgressNow = ref(Date.now())
const mentionStartIndex = ref<number | null>(null)
const mentionQuery = ref('')
const fileMentionSuggestions = ref<ComposerFileSuggestion[]>([])
const isFileMentionOpen = ref(false)
const fileMentionHighlightedIndex = ref(0)
let fileMentionSearchToken = 0
let fileMentionDebounceTimer: ReturnType<typeof setTimeout> | null = null
let goalProgressTimer: ReturnType<typeof setInterval> | null = null
let pluginLoadToken = 0
const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
const isIOS =
  typeof navigator !== 'undefined' &&
  (/iP(ad|hone|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const COMPOSER_INPUT_FALLBACK_MAX_HEIGHT = 180

const reasoningOptions: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
]
const modelOptions = computed(() =>
  props.models.map((modelId) => ({ value: modelId, label: modelId })),
)

const goalSlashCommand = computed<SkillItem>(() => ({
  name: 'Goal',
  description: props.goal
    ? 'Edit the goal Codex keeps working toward'
    : 'Set a goal Codex will keep working toward',
  path: GOAL_SLASH_COMMAND_PATH,
}))
const skillOptions = computed<SkillItem[]>(() => [goalSlashCommand.value, ...(props.skills ?? [])])
const selectedSkillPaths = computed(() => selectedSkills.value.map((s) => s.path))
const selectedPluginIds = computed(() => new Set(selectedPlugins.value.map((plugin) => plugin.id)))
const selectedThreadMentionIds = computed(() => new Set(selectedThreads.value.map((thread) => thread.id)))
const detachedFileAttachments = computed(() =>
  fileAttachments.value.filter((attachment) => !mentionedFilePaths.value.has(attachment.fsPath)),
)
const skillDropdownOptions = computed(() =>
  (props.skills ?? []).map((s) => ({
    value: s.path,
    label: s.name,
    description: s.description,
  })),
)
const pluginMentionSuggestions = computed(() => {
  const query = mentionQuery.value.trim().toLocaleLowerCase()
  const matches = query
    ? installedPlugins.value.filter((plugin) =>
        plugin.displayName.toLocaleLowerCase().includes(query)
          || plugin.name.toLocaleLowerCase().includes(query),
      )
    : installedPlugins.value
  return matches.slice(0, 6)
})
const threadMentionSuggestions = computed(() => {
  const query = mentionQuery.value.trim().toLocaleLowerCase()
  return (props.threads ?? [])
    .filter((thread) => thread.id !== props.activeThreadId)
    .filter((thread) => !query || thread.name.toLocaleLowerCase().includes(query))
    .slice(0, 6)
})
type ComposerMentionSuggestion =
  | { kind: 'plugin'; plugin: PluginMentionParam }
  | { kind: 'thread'; thread: ThreadMentionParam }
  | { kind: 'file'; file: ComposerFileSuggestion }
const composerMentionSuggestions = computed<ComposerMentionSuggestion[]>(() => [
  ...pluginMentionSuggestions.value.map((plugin) => ({ kind: 'plugin' as const, plugin })),
  ...threadMentionSuggestions.value.map((thread) => ({ kind: 'thread' as const, thread })),
  ...fileMentionSuggestions.value.map((file) => ({ kind: 'file' as const, file })),
])
const canSubmit = computed(() => {
  if (props.disabled) return false
  if (!props.activeThreadId) return false
  return draft.value.trim().length > 0
    || selectedImages.value.length > 0
    || fileAttachments.value.length > 0
    || responseTextAnnotations.value.length > 0
})
const isInteractionDisabled = computed(() => props.disabled || !props.activeThreadId)
const dictationButtonLabel = computed(() => {
  if (dictationState.value === 'recording') return 'Stop dictation'
  if (dictationState.value === 'transcribing') return 'Transcribing'
  return 'Start dictation'
})

function readComposerInputMaxHeight(input: HTMLTextAreaElement): number {
  const maxHeight = Number.parseFloat(window.getComputedStyle(input).maxHeight)
  return Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : COMPOSER_INPUT_FALLBACK_MAX_HEIGHT
}

function syncComposerInputHeight(): void {
  const input = inputRef.value
  if (!input) return

  input.style.height = 'auto'
  const maxHeight = readComposerInputMaxHeight(input)
  const nextHeight = Math.min(input.scrollHeight, maxHeight)
  input.style.height = `${nextHeight}px`
  input.style.overflowY = input.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden'
}

function focusComposerAfterThreadChange(): void {
  if (!props.activeThreadId || props.disabled || typeof window === 'undefined') return
  if (document.visibilityState !== 'visible') return
  if (!window.matchMedia('(min-width: 768px) and (pointer: fine)').matches) return
  focusComposer()
}

function focusComposer(): void {
  if (!props.activeThreadId || props.disabled) return
  inputRef.value?.focus({ preventScroll: true })
}

const goalStatusSummary = computed(() => {
  switch (props.goal?.status) {
    case 'active': return 'Pursuing goal'
    case 'paused': return 'Paused goal'
    case 'blocked': return 'Goal blocked'
    case 'usageLimited': return 'Goal usage limited'
    case 'budgetLimited': return 'Goal limited'
    case 'complete': return 'Goal achieved'
    default: return ''
  }
})

const goalProgressSummary = computed(() => {
  const goal = props.goal
  if (!goal) return ''
  if (typeof goal.tokenBudget === 'number' && goal.tokenBudget > 0) {
    return `Used ${compactNumberFormatter.format(goal.tokensUsed)} / ${compactNumberFormatter.format(goal.tokenBudget)} tokens`
  }

  const activeDeltaMs = goal.status === 'active'
    ? Math.max(goalProgressNow.value - (goal.updatedAt * 1000), 0)
    : 0
  return `Worked for ${formatGoalDuration((goal.timeUsedSeconds * 1000) + activeDeltaMs)}`
})

const shouldShowGoalExpand = computed(() => (props.goal?.objective.trim().length ?? 0) > 180)

const placeholderText = computed(() =>
  props.activeThreadId ? 'Type a message... (@ for plugins, chats & files, / for commands)' : 'Select a thread to send a message',
)

const contextUsage = computed(() => {
  const usage = props.threadTokenUsage
  const contextWindow = usage?.modelContextWindow ?? null
  const usedTokens = usage?.last.totalTokens ?? null

  if (contextWindow === null || contextWindow <= 0 || usedTokens === null || usedTokens < 0) {
    return null
  }

  const clampedUsedTokens = Math.min(usedTokens, contextWindow)
  const percent = Math.max(0, Math.min(100, (clampedUsedTokens / contextWindow) * 100))
  const roundedPercent = Math.round(percent)

  return {
    percent,
    roundedPercent,
    usedTokens: clampedUsedTokens,
    contextWindow,
    remainingPercent: Math.max(0, 100 - roundedPercent),
    remainingTokens: Math.max(0, contextWindow - clampedUsedTokens),
  }
})

const shouldShowContextUsageIndicator = computed(() => props.showContextUsage === true && Boolean(props.activeThreadId))

const contextUsageAngle = computed(() => {
  const usage = contextUsage.value
  return `${(usage?.percent ?? 0) * 3.6}deg`
})

const contextUsageAriaLabel = computed(() => {
  const usage = contextUsage.value
  if (!usage) return 'Context usage unavailable'
  return `Context usage: ${usage.roundedPercent}%`
})

const contextUsageStatusLabel = computed(() => {
  const usage = contextUsage.value
  if (!usage) return ''
  if (usage.roundedPercent >= 100) return '100% full'
  return `${usage.roundedPercent}% used (${usage.remainingPercent}% left)`
})

const contextUsageTooltip = computed(() => {
  const usage = contextUsage.value
  if (!usage) return 'Context usage unavailable'
  return `${contextUsageStatusLabel.value} · ${compactNumberFormatter.format(usage.usedTokens)} / ${compactNumberFormatter.format(usage.contextWindow)} tokens used`
})

const contextUsageToneClass = computed(() => {
  const usage = contextUsage.value
  if (!usage) return 'is-unavailable'
  if (usage.roundedPercent >= 95) return 'is-critical'
  if (usage.roundedPercent >= 80) return 'is-warning'
  return 'is-normal'
})

function onSubmit(mode: 'steer' | 'queue' = 'steer'): void {
  if (tryHandleGoalSlashCommand()) return
  const text = draft.value.trim()
  if (!canSubmit.value) return
  emit('submit', {
    text,
    imageUrls: selectedImages.value.map((image) => image.url),
    fileAttachments: [...fileAttachments.value],
    responseTextAnnotations: [...responseTextAnnotations.value],
    skills: selectedSkills.value.map((s) => ({ name: s.name, path: s.path })),
    plugins: [...selectedPlugins.value],
    threads: [...selectedThreads.value],
    mode,
  })
  draft.value = ''
  selectedImages.value = []
  selectedSkills.value = []
  selectedPlugins.value = []
  selectedThreads.value = []
  fileAttachments.value = []
  mentionedFilePaths.value = new Set()
  responseTextAnnotations.value = []
  isAttachMenuOpen.value = false
  isSlashMenuOpen.value = false
  closeFileMention()
  nextTick(syncComposerInputHeight)
  if (isAndroid) {
    inputRef.value?.blur()
    return
  }
  nextTick(() => inputRef.value?.focus())
}

function formatGoalDuration(durationMs: number): string {
  const safeDurationMs = Math.max(durationMs, 0)
  if (safeDurationMs < 1000) return '0s'
  if (safeDurationMs < 60000) return `${Math.floor(safeDurationMs / 1000)}s`

  const minutes = Math.floor(safeDurationMs / 60000)
  const seconds = Math.floor((safeDurationMs % 60000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function clearGoalProgressTimer(): void {
  if (goalProgressTimer === null) return
  clearInterval(goalProgressTimer)
  goalProgressTimer = null
}

function syncGoalProgressTimer(): void {
  clearGoalProgressTimer()
  goalProgressNow.value = Date.now()
  if (props.goal?.status !== 'active') return

  goalProgressTimer = setInterval(() => {
    goalProgressNow.value = Date.now()
  }, 1000)
}

function openGoalEditor(objective = ''): void {
  goalDraft.value = objective.trim()
  isGoalEditorOpen.value = true
  nextTick(() => goalInputRef.value?.focus())
}

function closeGoalEditor(): void {
  isGoalEditorOpen.value = false
  goalDraft.value = ''
  nextTick(() => inputRef.value?.focus())
}

function saveGoal(): void {
  const objective = goalDraft.value.trim()
  if (!objective) return
  applyGoalObjective(objective)
  closeGoalEditor()
}

function emitGoalStatusUpdate(status: ThreadGoalStatus): void {
  emit('update-goal-status', { status })
}

function onGoalInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeGoalEditor()
    return
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    saveGoal()
  }
}

function applyGoalObjective(objective: string): void {
  emit('set-goal', { objective })
  isGoalObjectiveExpanded.value = false
}

function shouldConfirmGoalReplacement(objective: string): boolean {
  const currentObjective = props.goal?.objective.trim() ?? ''
  return currentObjective.length > 0 && currentObjective !== objective
}

function clearComposerAfterGoalCommand(): void {
  draft.value = ''
  isSlashMenuOpen.value = false
  closeFileMention()
  selectedImages.value = []
  selectedSkills.value = []
  selectedPlugins.value = []
  selectedThreads.value = []
  fileAttachments.value = []
  mentionedFilePaths.value = new Set()
  responseTextAnnotations.value = []
  isAttachMenuOpen.value = false
}

function confirmGoalReplacement(): void {
  const objective = pendingGoalReplacementObjective.value.trim()
  if (!objective) {
    pendingGoalReplacementObjective.value = ''
    return
  }

  pendingGoalReplacementObjective.value = ''
  clearComposerAfterGoalCommand()
  applyGoalObjective(objective)
  nextTick(() => inputRef.value?.focus())
}

function cancelGoalReplacement(): void {
  pendingGoalReplacementObjective.value = ''
  nextTick(() => inputRef.value?.focus())
}

function tryHandleGoalSlashCommand(): boolean {
  const text = draft.value.trim()
  if (!text.startsWith('/')) return false
  if (!GOAL_SLASH_COMMAND_PATTERN.test(text)) return false

  const objective = text.replace(GOAL_SLASH_COMMAND_PREFIX_PATTERN, '').trim()
  if (objective.length > 0) {
    if (shouldConfirmGoalReplacement(objective)) {
      pendingGoalReplacementObjective.value = objective
      isSlashMenuOpen.value = false
      closeFileMention()
      return true
    }
    clearComposerAfterGoalCommand()
    applyGoalObjective(objective)
  } else {
    clearComposerAfterGoalCommand()
    openGoalEditor(props.goal?.objective ?? '')
  }
  return true
}

function onInterrupt(): void {
  emit('interrupt')
}

function toggleDictation(): void {
  if (isInteractionDisabled.value || dictationState.value === 'transcribing') return
  if (dictationState.value === 'recording') {
    stopRecording()
    return
  }
  void startRecording()
}

function addResponseAnnotation(annotation: ResponseTextAnnotation): void {
  const text = annotation.text.trim()
  if (!text) return
  responseTextAnnotations.value = [
    ...responseTextAnnotations.value,
    {
      ...annotation,
      text,
      ...(annotation.annotation?.trim() ? { annotation: annotation.annotation.trim() } : { annotation: undefined }),
    },
  ]
  nextTick(() => inputRef.value?.focus({ preventScroll: true }))
}

function removeResponseAnnotation(annotationId: string): void {
  responseTextAnnotations.value = responseTextAnnotations.value.filter((annotation) => annotation.id !== annotationId)
}

function selectionCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'selection' : 'selections'}`
}

defineExpose({ toggleDictation, addResponseAnnotation, focusComposer })

function onModelSelect(value: string): void {
  emit('update:selected-model', value)
}

function onReasoningEffortSelect(value: string): void {
  emit('update:selected-reasoning-effort', value as ReasoningEffort)
}

function toggleAttachMenu(): void {
  if (isInteractionDisabled.value) return
  isAttachMenuOpen.value = !isAttachMenuOpen.value
}

function triggerPhotoLibrary(): void {
  photoLibraryInputRef.value?.click()
}

function triggerCameraCapture(): void {
  cameraCaptureInputRef.value?.click()
}

function removeImage(id: string): void {
  selectedImages.value = selectedImages.value.filter((image) => image.id !== id)
}

function removeSkill(path: string): void {
  selectedSkills.value = selectedSkills.value.filter((s) => s.path !== path)
}

function removePlugin(pluginId: string): void {
  selectedPlugins.value = selectedPlugins.value.filter((plugin) => plugin.id !== pluginId)
}

function removeThreadMention(threadId: string): void {
  selectedThreads.value = selectedThreads.value.filter((thread) => thread.id !== threadId)
}

async function refreshInstalledPlugins(): Promise<void> {
  const token = ++pluginLoadToken
  isLoadingPlugins.value = true
  pluginLoadError.value = ''
  try {
    const plugins = await getInstalledPlugins(props.cwd)
    if (token !== pluginLoadToken) return
    installedPlugins.value = plugins
    const availableIds = new Set(plugins.map((plugin) => plugin.id))
    selectedPlugins.value = selectedPlugins.value.filter((plugin) => availableIds.has(plugin.id))
  } catch {
    if (token !== pluginLoadToken) return
    if (installedPlugins.value.length === 0) {
      pluginLoadError.value = 'Could not load installed plugins'
    }
  } finally {
    if (token === pluginLoadToken) {
      isLoadingPlugins.value = false
    }
  }
}

function removeFileAttachment(fsPath: string): void {
  fileAttachments.value = fileAttachments.value.filter((a) => a.fsPath !== fsPath)
  if (!mentionedFilePaths.value.has(fsPath)) return
  mentionedFilePaths.value = new Set([...mentionedFilePaths.value].filter((path) => path !== fsPath))
  const token = `@${fsPath}`
  draft.value = draft.value
    .split(token)
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
}

function addFileAttachment(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/')
  if (fileAttachments.value.some((a) => a.fsPath === normalized)) return
  const parts = normalized.split('/').filter(Boolean)
  const label = parts[parts.length - 1] ?? normalized
  fileAttachments.value = [...fileAttachments.value, { label, path: normalized, fsPath: normalized }]
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp)$/i.test(file.name)
}

function addFiles(files: FileList | readonly File[] | null): void {
  if (!files || files.length === 0) return
  for (const file of Array.from(files)) {
    if (isImageFile(file)) {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') return
        selectedImages.value.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          url: reader.result,
        })
      }
      reader.readAsDataURL(file)
    } else {
      void uploadFile(file).then((serverPath) => {
        if (serverPath) addFileAttachment(serverPath)
      }).catch(() => {})
    }
  }
}

function getClipboardFiles(clipboardData: DataTransfer): File[] {
  const directFiles = Array.from(clipboardData.files)
  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === 'file')
    .flatMap((item) => {
      const file = item.getAsFile()
      return file ? [file] : []
    })

  return itemFiles.length > directFiles.length ? itemFiles : directFiles
}

function onInputPaste(event: ClipboardEvent): void {
  const clipboardData = event.clipboardData
  if (!clipboardData) return

  const files = getClipboardFiles(clipboardData).filter((file) => file.size > 0)
  if (files.length === 0) return

  event.preventDefault()
  addFiles(files)
}

function clearInputValue(inputRefEl: HTMLInputElement | null): void {
  if (inputRefEl) inputRefEl.value = ''
}

function onPhotoLibraryChange(event: Event): void {
  const input = event.target as HTMLInputElement | null
  addFiles(input?.files ?? null)
  clearInputValue(input)
  isAttachMenuOpen.value = false
}

function onCameraCaptureChange(event: Event): void {
  const input = event.target as HTMLInputElement | null
  addFiles(input?.files ?? null)
  clearInputValue(input)
  isAttachMenuOpen.value = false
}

function onInputChange(): void {
  syncComposerInputHeight()
  syncMentionAttachmentsFromDraft()
  const text = draft.value
  if (text === '/') {
    isSlashMenuOpen.value = true
  } else if (isSlashMenuOpen.value && !text.startsWith('/')) {
    isSlashMenuOpen.value = false
  }
  updateFileMentionState()
}

function stabilizeMobileComposerFocus(): void {
  if (!isIOS || typeof window === 'undefined') return

  const resetPageScroll = () => {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }

  resetPageScroll()
  window.requestAnimationFrame(() => {
    resetPageScroll()
    window.requestAnimationFrame(resetPageScroll)
  })
}

function onInputFocus(): void {
  stabilizeMobileComposerFocus()
}

function onInputKeydown(event: KeyboardEvent): void {
  if (isFileMentionOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeFileMention()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (composerMentionSuggestions.value.length > 0) {
        fileMentionHighlightedIndex.value =
          (fileMentionHighlightedIndex.value + 1) % composerMentionSuggestions.value.length
      }
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (composerMentionSuggestions.value.length > 0) {
        const size = composerMentionSuggestions.value.length
        fileMentionHighlightedIndex.value = (fileMentionHighlightedIndex.value + size - 1) % size
      }
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const selected = composerMentionSuggestions.value[fileMentionHighlightedIndex.value]
      if (selected?.kind === 'plugin') {
        applyPluginMention(selected.plugin)
      } else if (selected?.kind === 'thread') {
        applyThreadMention(selected.thread)
      } else if (selected?.kind === 'file') {
        applyFileMention(selected.file)
      } else {
        closeFileMention()
      }
      return
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    onSubmit('steer')
    return
  }

  if (isSlashMenuOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSlashMenu()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      return
    }
  }
}

function closeSlashMenu(): void {
  isSlashMenuOpen.value = false
  inputRef.value?.focus()
}

function closeFileMention(): void {
  isFileMentionOpen.value = false
  mentionStartIndex.value = null
  mentionQuery.value = ''
  fileMentionSuggestions.value = []
  fileMentionHighlightedIndex.value = 0
}

function updateFileMentionState(): void {
  const input = inputRef.value
  if (!input) {
    closeFileMention()
    return
  }
  const cursor = input.selectionStart ?? draft.value.length
  const beforeCursor = draft.value.slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)(@[^\s@]*)$/)
  if (!match) {
    closeFileMention()
    return
  }

  const mentionToken = match[2] ?? ''
  const mentionOffset = mentionToken.length
  const startIndex = cursor - mentionOffset
  mentionStartIndex.value = startIndex
  mentionQuery.value = mentionToken.slice(1)
  isFileMentionOpen.value = true
  void queueFileMentionSearch()
}

async function queueFileMentionSearch(): Promise<void> {
  if (!isFileMentionOpen.value) return
  const cwd = (props.cwd ?? '').trim()
  if (!cwd) {
    fileMentionSuggestions.value = []
    return
  }
  if (fileMentionDebounceTimer) {
    clearTimeout(fileMentionDebounceTimer)
  }
  const token = ++fileMentionSearchToken
  fileMentionDebounceTimer = setTimeout(async () => {
    try {
      const rows = await searchComposerFiles(cwd, mentionQuery.value, 20)
      if (!isFileMentionOpen.value || token !== fileMentionSearchToken) return
      fileMentionSuggestions.value = rows
      fileMentionHighlightedIndex.value = 0
    } catch {
      if (!isFileMentionOpen.value || token !== fileMentionSearchToken) return
      fileMentionSuggestions.value = []
    }
  }, 120)
}

function applyPluginMention(plugin: PluginMentionParam): void {
  if (!selectedPluginIds.value.has(plugin.id)) {
    selectedPlugins.value = [...selectedPlugins.value, plugin]
  }
  clearActiveMentionToken()
}

function applyThreadMention(thread: ThreadMentionParam): void {
  if (!selectedThreadMentionIds.value.has(thread.id)) {
    selectedThreads.value = [...selectedThreads.value, thread]
  }
  clearActiveMentionToken()
}

function clearActiveMentionToken(): void {
  const input = inputRef.value
  const start = mentionStartIndex.value
  if (start !== null && input) {
    const cursor = input.selectionStart ?? draft.value.length
    let before = draft.value.slice(0, start)
    let after = draft.value.slice(cursor)
    if (before.length === 0) {
      after = after.replace(/^\s+/u, '')
    } else if (/\s$/u.test(before) && /^\s/u.test(after)) {
      after = after.replace(/^\s+/u, '')
    } else if (after.length > 0 && !/\s$/u.test(before) && !/^\s/u.test(after)) {
      before += ' '
    }
    draft.value = `${before}${after}`
    const nextCursor = before.length
    closeFileMention()
    nextTick(() => {
      input.focus()
      input.setSelectionRange(nextCursor, nextCursor)
      syncComposerInputHeight()
    })
    return
  }

  closeFileMention()
  nextTick(() => input?.focus())
}

function applyFileMention(suggestion: ComposerFileSuggestion): void {
  const input = inputRef.value
  const start = mentionStartIndex.value
  if (start !== null && input) {
    const cursor = input.selectionStart ?? draft.value.length
    const before = draft.value.slice(0, start)
    const after = draft.value.slice(cursor)
    const mentionText = `@${suggestion.path}`
    const trailingSpace = after.length === 0 || !/^\s/u.test(after) ? ' ' : ''
    draft.value = `${before}${mentionText}${trailingSpace}${after}`
    const nextCursor = before.length + mentionText.length + trailingSpace.length
    mentionedFilePaths.value = new Set([...mentionedFilePaths.value, suggestion.path])
    addFileAttachment(suggestion.path)
    closeFileMention()
    nextTick(() => {
      input.focus()
      input.setSelectionRange(nextCursor, nextCursor)
      syncComposerInputHeight()
    })
    return
  }
  addFileAttachment(suggestion.path)
  closeFileMention()
  nextTick(() => input?.focus())
}

function syncMentionAttachmentsFromDraft(): void {
  if (mentionedFilePaths.value.size === 0) return
  const retainedPaths = new Set(
    [...mentionedFilePaths.value].filter((path) => draft.value.includes(`@${path}`)),
  )
  if (retainedPaths.size === mentionedFilePaths.value.size) return
  const removedPaths = new Set(
    [...mentionedFilePaths.value].filter((path) => !retainedPaths.has(path)),
  )
  mentionedFilePaths.value = retainedPaths
  fileAttachments.value = fileAttachments.value.filter((attachment) => !removedPaths.has(attachment.fsPath))
}

function getMentionFileName(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return path
  return path.slice(idx + 1)
}

function getMentionDirName(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return ''
  return path.slice(0, idx)
}

function getFileExtension(path: string): string {
  const base = getMentionFileName(path)
  const idx = base.lastIndexOf('.')
  if (idx <= 0) return ''
  return base.slice(idx + 1).toLowerCase()
}

function getMentionBadgeText(path: string): string {
  const ext = getFileExtension(path)
  if (ext === 'ts') return 'TS'
  if (ext === 'tsx') return 'TSX'
  if (ext === 'js') return 'JS'
  if (ext === 'jsx') return 'JSX'
  if (ext === 'json') return '{}'
  return ''
}

function getMentionBadgeClass(path: string): string {
  const ext = getFileExtension(path)
  if (ext.startsWith('ts')) return 'ts'
  if (ext.startsWith('js')) return 'js'
  if (ext === 'json') return 'json'
  return 'default'
}

function isMarkdownFile(path: string): boolean {
  const ext = getFileExtension(path)
  return ext === 'md' || ext === 'mdx'
}

function onSlashSkillSelect(skill: SkillItem): void {
  if (skill.path === GOAL_SLASH_COMMAND_PATH) {
    draft.value = ''
    isSlashMenuOpen.value = false
    closeFileMention()
    openGoalEditor(props.goal?.objective ?? '')
    return
  }
  if (!selectedSkills.value.some((s) => s.path === skill.path)) {
    selectedSkills.value = [...selectedSkills.value, skill]
  }
  draft.value = draft.value.startsWith('/') ? '' : draft.value
  isSlashMenuOpen.value = false
  inputRef.value?.focus()
}

function onSkillDropdownToggle(path: string, checked: boolean): void {
  if (checked) {
    const skill = (props.skills ?? []).find((s) => s.path === path)
    if (skill && !selectedSkills.value.some((s) => s.path === path)) {
      selectedSkills.value = [...selectedSkills.value, skill]
    }
  } else {
    selectedSkills.value = selectedSkills.value.filter((s) => s.path !== path)
  }
}

function onDocumentClick(event: MouseEvent): void {
  if (!isAttachMenuOpen.value) return
  const root = attachMenuRootRef.value
  if (!root) return
  const target = event.target as Node | null
  if (!target || root.contains(target)) return
  isAttachMenuOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  syncGoalProgressTimer()
  syncComposerInputHeight()
  void refreshInstalledPlugins()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  pluginLoadToken += 1
  if (fileMentionDebounceTimer) {
    clearTimeout(fileMentionDebounceTimer)
  }
  clearGoalProgressTimer()
})

watch(
  () => props.activeThreadId,
  () => {
    draft.value = ''
    goalDraft.value = ''
    isGoalEditorOpen.value = false
    isGoalObjectiveExpanded.value = false
    pendingGoalReplacementObjective.value = ''
    selectedImages.value = []
    selectedSkills.value = []
    selectedPlugins.value = []
    selectedThreads.value = []
    fileAttachments.value = []
    mentionedFilePaths.value = new Set()
    responseTextAnnotations.value = []
    isAttachMenuOpen.value = false
    isSlashMenuOpen.value = false
    closeFileMention()
    nextTick(() => {
      syncComposerInputHeight()
      focusComposerAfterThreadChange()
    })
  },
)

watch(draft, () => nextTick(syncComposerInputHeight))

watch(
  () => props.cwd,
  () => {
    void refreshInstalledPlugins()
    if (isFileMentionOpen.value) {
      void queueFileMentionSearch()
    }
  },
)

watch(
  () => [props.goal?.status, props.goal?.updatedAt] as const,
  () => {
    syncGoalProgressTimer()
    if (!props.goal) {
      isGoalObjectiveExpanded.value = false
      pendingGoalReplacementObjective.value = ''
      if (!isGoalEditorOpen.value) {
        goalDraft.value = ''
      }
      return
    }
    if (!isGoalEditorOpen.value) {
      goalDraft.value = ''
    }
  },
)
</script>

<style scoped>
@reference "tailwindcss";

.thread-composer {
  @apply w-full max-w-[44rem] mx-auto px-3 pb-2.5 sm:px-5 sm:pb-0;
  padding-bottom: max(var(--thread-composer-bottom-clearance, 0.875rem), env(safe-area-inset-bottom));
}

@media (min-width: 640px) {
  .thread-composer {
    padding-bottom: 0;
  }
}

:global(.desktop-layout.is-keyboard-open) {
  --thread-composer-bottom-clearance: 0.375rem;
}

.thread-composer-shell {
  @apply relative rounded-2xl border border-zinc-300 bg-white p-1.5 shadow-sm sm:p-3;
}

.thread-composer-shell--no-top-radius {
  @apply rounded-t-none border-t-0;
}

.thread-composer-response-annotations {
  @apply mb-2 flex flex-wrap;
}

.thread-composer-response-annotations-trigger {
  @apply inline-flex h-7 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-100;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.thread-composer-response-annotations-trigger:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
}

.thread-composer-response-annotations-trigger-icon {
  @apply h-3.5 w-3.5 shrink-0 text-zinc-500;
  color: var(--text-tertiary);
}

:global(.thread-composer-response-annotations-popover) {
  width: min(23rem, calc(100vw - 1rem)) !important;
  max-height: min(24rem, 60vh);
  gap: 0 !important;
  overflow: hidden;
  padding: 0 !important;
  border: 1px solid var(--border-soft);
  background: var(--surface-elevated) !important;
  color: var(--text-primary) !important;
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.18) !important;
}

:global(.thread-composer-response-annotations-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--border-soft);
  font-size: 0.75rem;
  font-weight: 600;
}

:global(.thread-composer-response-annotations-list) {
  display: flex;
  max-height: min(20rem, 52vh);
  flex-direction: column;
  gap: 0.25rem;
  overflow-y: auto;
  padding: 0.375rem;
}

:global(.thread-composer-response-annotation) {
  display: flex;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem;
  border-left: 2px solid var(--border-strong);
}

:global(.thread-composer-response-annotation-content) {
  min-width: 0;
  flex: 1;
}

:global(.thread-composer-response-annotation-quote) {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.125rem;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

:global(.thread-composer-response-annotation-comment) {
  margin: 0.25rem 0 0;
  color: var(--text-primary);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.125rem;
  white-space: pre-wrap;
}

:global(.thread-composer-response-annotation-remove) {
  flex: none;
  color: var(--text-tertiary) !important;
}

.thread-composer-attachments {
  @apply mb-2 flex flex-wrap gap-2;
}

.thread-composer-attachment {
  @apply relative h-14 w-14 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50;
}

.thread-composer-attachment-image {
  @apply h-full w-full object-cover;
}

.thread-composer-attachment-remove {
  @apply absolute right-0.5 top-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border-0 bg-black/70 text-xs leading-none text-white;
}

.thread-composer-file-chips {
  @apply mb-2 flex flex-wrap gap-1.5;
}

.thread-composer-file-chip {
  @apply inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-700;
}

.thread-composer-file-chip-icon {
  @apply h-3.5 w-3.5 text-zinc-400 shrink-0;
}

.thread-composer-file-chip-name {
  @apply truncate max-w-40 font-mono;
}

.thread-composer-file-chip-remove {
  @apply ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border-0 bg-transparent text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700 text-xs leading-none p-0;
}

.thread-composer-skill-chips {
  @apply mb-2 flex flex-wrap gap-1.5;
}

.thread-composer-skill-chip {
  @apply inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700;
}

.thread-composer-skill-chip-name {
  @apply font-medium;
}

.thread-composer-skill-chip-remove {
  @apply ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border-0 bg-transparent text-emerald-500 transition hover:bg-emerald-200 hover:text-emerald-700 text-xs leading-none p-0;
}

.thread-composer-plugin-chips {
  @apply mb-2 flex flex-wrap gap-1.5;
}

.thread-composer-plugin-chip {
  @apply inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-primary);
}

.thread-composer-plugin-chip-icon {
  @apply h-3.5 w-3.5 shrink-0;
  color: var(--text-tertiary);
}

.thread-composer-plugin-chip-name {
  @apply font-medium;
}

.thread-composer-plugin-chip-remove {
  @apply ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border-0 bg-transparent p-0 text-xs leading-none transition;
  color: var(--text-tertiary);
}

.thread-composer-plugin-chip-remove:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-composer-thread-chips {
  @apply mb-2 flex flex-wrap gap-1.5;
}

.thread-composer-thread-chip {
  @apply inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-primary);
}

.thread-composer-thread-chip-icon {
  @apply h-3.5 w-3.5 shrink-0;
  color: var(--text-tertiary);
}

.thread-composer-thread-chip-name {
  @apply max-w-48 truncate font-medium;
}

.thread-composer-thread-chip-remove {
  @apply ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-xs leading-none transition;
  color: var(--text-tertiary);
}

.thread-composer-thread-chip-remove:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-composer-goal-card {
  @apply mb-2 rounded-xl border px-3 py-2;
  background: var(--surface-muted);
  border-color: var(--border-soft);
  color: var(--text-primary);
}

.thread-composer-goal-header {
  @apply flex flex-wrap items-start justify-between gap-2;
}

.thread-composer-goal-summary {
  @apply flex min-w-0 flex-wrap items-center gap-2;
}

.thread-composer-goal-badge {
  @apply inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide;
  background: var(--surface-active);
  color: var(--text-primary);
}

.thread-composer-goal-status {
  @apply text-sm font-medium;
  color: var(--text-primary);
}

.thread-composer-goal-progress {
  @apply text-xs font-medium;
  color: var(--text-muted);
}

.thread-composer-goal-actions {
  @apply flex flex-wrap items-center gap-1;
}

.thread-composer-goal-action {
  @apply inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50;
  background: var(--surface-elevated);
  border-color: var(--border-soft);
  color: var(--text-secondary);
}

.thread-composer-goal-action:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-composer-goal-action--danger {
  border-color: rgba(220, 38, 38, 0.35);
  color: #dc2626;
}

.thread-composer-goal-objective {
  @apply mt-2 whitespace-pre-wrap text-sm;
  color: var(--text-primary);
}

.thread-composer-goal-objective.is-collapsed {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.thread-composer-goal-expand {
  @apply mt-1 text-xs font-medium transition;
  color: var(--text-secondary);
}

.thread-composer-goal-expand:hover {
  color: var(--text-primary);
}

.thread-composer-goal-input {
  @apply mt-2 w-full min-h-[5.5rem] rounded-lg border px-3 py-2 text-base sm:text-sm outline-none resize-y;
  background: var(--surface-elevated);
  border-color: var(--border-soft);
  color: var(--text-primary);
}

.thread-composer-goal-input:focus {
  border-color: var(--border-strong);
}

.thread-composer-goal-editor-actions {
  @apply mt-2 flex flex-wrap items-center gap-2;
}

.thread-composer-goal-save {
  @apply inline-flex items-center rounded-md border-0 px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50;
  background: var(--surface-inverse);
  color: var(--content-bg);
}

.thread-composer-goal-save:hover {
  filter: brightness(0.92);
}

.thread-composer-goal-cancel {
  @apply inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50;
  background: var(--surface-elevated);
  border-color: var(--border-soft);
  color: var(--text-secondary);
}

.thread-composer-goal-cancel:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-composer-goal-modal-backdrop {
  @apply fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center;
}

.thread-composer-goal-modal {
  @apply w-full max-w-md rounded-2xl border p-4 shadow-xl;
  background: var(--surface-elevated);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.thread-composer-goal-modal-header {
  @apply flex flex-col gap-1;
}

.thread-composer-goal-modal-title {
  @apply text-lg font-semibold;
  color: var(--text-primary);
}

.thread-composer-goal-modal-copy {
  @apply text-sm;
  color: var(--text-secondary);
}

.thread-composer-goal-modal-preview {
  @apply mt-3 rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap;
  background: var(--surface-muted);
  color: var(--text-primary);
}

.thread-composer-goal-modal-actions {
  @apply mt-4 flex flex-wrap items-center justify-end gap-2;
}

.thread-composer-goal-modal-cancel {
  @apply inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition;
  background: var(--surface-elevated);
  border-color: var(--border-soft);
  color: var(--text-secondary);
}

.thread-composer-goal-modal-cancel:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-composer-goal-modal-confirm {
  @apply inline-flex items-center rounded-md border-0 px-3 py-1.5 text-sm font-medium transition;
  background: var(--surface-inverse);
  color: var(--content-bg);
}

.thread-composer-goal-modal-confirm:hover {
  filter: brightness(0.92);
}

.thread-composer-input-wrap {
  @apply relative;
}

.thread-composer-file-mentions {
  @apply absolute left-0 right-0 bottom-[calc(100%+8px)] z-40 max-h-52 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.thread-composer-file-mention-section {
  @apply px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide;
  color: var(--text-muted);
}

.thread-composer-file-mention-row {
  @apply flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-xs text-zinc-700 transition hover:bg-zinc-100;
  color: var(--text-secondary);
}

.thread-composer-file-mention-row:hover,
.thread-composer-file-mention-row.is-active {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-composer-file-mention-plugin-icon {
  @apply h-4 w-4 shrink-0;
  color: var(--text-tertiary);
}

.thread-composer-file-mention-check {
  @apply ml-auto h-4 w-4 shrink-0;
  color: var(--accent);
}

.thread-composer-file-mention-icon-badge {
  @apply inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[9px] font-semibold leading-none;
}

.thread-composer-file-mention-icon-badge.is-ts {
  @apply bg-zinc-700 text-white;
}

.thread-composer-file-mention-icon-badge.is-js {
  @apply bg-zinc-600 text-white;
}

.thread-composer-file-mention-icon-badge.is-json {
  @apply bg-zinc-600 text-white;
}

.thread-composer-file-mention-icon-markdown {
  @apply inline-flex h-5 min-w-5 items-center justify-center text-sm leading-none text-zinc-700;
  color: var(--text-secondary);
}

.thread-composer-file-mention-icon-file {
  @apply h-4 w-4 text-zinc-600;
  color: var(--text-tertiary);
}

.thread-composer-file-mention-text {
  @apply flex min-w-0 flex-1 items-baseline gap-2;
}

.thread-composer-file-mention-name {
  @apply truncate text-zinc-900;
  color: var(--text-primary);
}

.thread-composer-file-mention-dir {
  @apply truncate text-zinc-400;
  color: var(--text-muted);
}

.thread-composer-file-mention-empty {
  @apply px-2 py-1.5 text-xs text-zinc-500;
  color: var(--text-muted);
}

.thread-composer-input {
  @apply block w-full min-w-0 min-h-9 sm:min-h-11 rounded-xl border-0 bg-transparent px-1 py-1.5 text-base leading-6 sm:py-2 sm:text-sm sm:leading-5 text-zinc-900 outline-none transition resize-none;
  max-height: min(9rem, 34dvh);
  scrollbar-gutter: stable;
}

.thread-composer-input:focus {
  @apply ring-0;
}

.thread-composer-input:disabled {
  @apply bg-zinc-100 text-zinc-500 cursor-not-allowed;
}

.thread-composer-controls {
  @apply mt-1.5 flex min-w-0 flex-nowrap items-center gap-1 sm:mt-3 sm:gap-4;
}

.thread-composer-option-strip {
  @apply flex min-w-0 flex-1 basis-auto items-center gap-1 overflow-visible sm:gap-4;
}

.thread-composer-attach {
  @apply relative inline-flex shrink-0 items-center gap-1;
}

.thread-composer-attach-trigger {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-xl leading-none text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-400 sm:h-9 sm:w-9;
}

.thread-composer-attach-menu {
  @apply absolute bottom-11 left-0 z-20 min-w-44 max-sm:min-w-40 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.thread-composer-attach-menu--plugins {
  width: min(20rem, calc(100vw - 1rem));
  padding: 0.375rem;
}

.thread-composer-attach-item {
  @apply block w-full rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400;
  color: var(--text-primary);
}

.thread-composer-attach-item--plugins {
  @apply mt-1 flex items-center justify-between border-t pt-2;
  border-color: var(--border-soft);
}

.thread-composer-attach-item-label {
  @apply inline-flex min-w-0 items-center gap-2;
}

.thread-composer-attach-item-icon {
  @apply h-4 w-4 shrink-0;
  color: var(--text-tertiary);
}

.thread-composer-attach-item-count {
  @apply inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold;
  background: var(--surface-active);
  color: var(--text-secondary);
}

.thread-composer-plugin-menu-header {
  @apply flex h-8 items-center gap-1 px-1 text-sm font-semibold;
  color: var(--text-primary);
}

.thread-composer-plugin-menu-back {
  @apply inline-flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent transition;
  color: var(--text-secondary);
}

.thread-composer-plugin-menu-back:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.thread-composer-plugin-menu-back svg {
  @apply h-4 w-4;
}

.thread-composer-plugin-search {
  @apply mb-1 flex items-center gap-2 rounded-lg border px-2;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-tertiary);
}

.thread-composer-plugin-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-soft);
}

.thread-composer-plugin-search-icon {
  @apply h-4 w-4 shrink-0;
}

.thread-composer-plugin-search input {
  @apply h-8 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none;
  color: var(--text-primary);
}

.thread-composer-plugin-search input::placeholder {
  color: var(--text-muted);
}

.thread-composer-plugin-list {
  @apply flex max-h-64 flex-col overflow-y-auto;
}

.thread-composer-plugin-option {
  @apply flex w-full items-start gap-2 rounded-lg border-0 bg-transparent px-2 py-2 text-left transition;
  color: var(--text-primary);
}

.thread-composer-plugin-option:hover,
.thread-composer-plugin-option.is-selected {
  background: var(--surface-hover);
}

.thread-composer-plugin-option-icon {
  @apply mt-0.5 h-4 w-4 shrink-0;
  color: var(--text-tertiary);
}

.thread-composer-plugin-option-copy {
  @apply flex min-w-0 flex-1 flex-col;
}

.thread-composer-plugin-option-name {
  @apply truncate text-sm font-medium;
}

.thread-composer-plugin-option-description {
  @apply line-clamp-2 text-xs leading-4;
  color: var(--text-muted);
}

.thread-composer-plugin-option-check {
  @apply mt-0.5 h-4 w-4 shrink-0;
  color: var(--accent);
}

.thread-composer-plugin-menu-message {
  @apply m-0 px-2 py-4 text-center text-xs;
  color: var(--text-muted);
}

.thread-composer-plugin-menu-message.is-error {
  color: rgb(220 38 38);
}

.thread-composer-control {
  @apply min-w-0 shrink;
}

.thread-composer-control--skills {
  @apply hidden sm:inline-flex;
}

.thread-composer-control--model {
  @apply flex-none max-w-[6.75rem] sm:max-w-none;
}

.thread-composer-control--reasoning {
  @apply flex-none max-w-[5.75rem] sm:max-w-none;
}

.thread-composer-control :deep(.composer-dropdown-trigger),
.thread-composer-control :deep(.search-dropdown-trigger) {
  @apply w-full max-w-full;
}

.thread-composer-control :deep(.composer-dropdown-value),
.thread-composer-control :deep(.search-dropdown-value) {
  @apply min-w-0 truncate;
}

.thread-composer-separator {
  @apply hidden sm:block border-l border-zinc-200 h-5 mx-1 shrink-0;
}

.thread-composer-context-usage {
  @apply order-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full sm:order-none sm:h-8 sm:w-8;
  background: var(--surface-elevated);
  border: 1px solid var(--border-soft);
  color: var(--text-secondary);
}

.thread-composer-context-usage-ring {
  @apply relative block h-3 w-3 rounded-full sm:h-3.5 sm:w-3.5;
  background:
    conic-gradient(var(--context-usage-color, currentColor) 0deg var(--context-usage-angle), var(--surface-active) var(--context-usage-angle) 360deg);
}

.thread-composer-context-usage-ring-core {
  @apply absolute inset-[3px] rounded-full;
  background: var(--surface-elevated);
}

.thread-composer-context-usage-ring.is-normal {
  --context-usage-color: var(--text-secondary);
}

.thread-composer-context-usage-ring.is-unavailable {
  --context-usage-color: transparent;
  opacity: 0.72;
}

.thread-composer-context-usage-ring.is-warning {
  --context-usage-color: rgb(217 119 6);
}

.thread-composer-context-usage-ring.is-critical {
  --context-usage-color: rgb(220 38 38);
}

.thread-composer-actions {
  @apply order-3 ml-auto flex shrink-0 items-center gap-2 sm:order-none sm:gap-2.5;
}

.thread-composer-mic {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-sky-700 shadow-sm transition hover:border-sky-300 hover:bg-sky-100 hover:text-sky-800 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400 sm:h-9 sm:w-9;
}

.thread-composer-mic--recording {
  @apply border-red-600 bg-red-600 text-white shadow-sm shadow-red-200 hover:border-red-700 hover:bg-red-700 hover:text-white;
  animation: thread-composer-mic-pulse 1.35s ease-in-out infinite;
}

.thread-composer-mic--transcribing {
  @apply border-amber-200 bg-amber-100 text-amber-700 hover:border-amber-200 hover:bg-amber-100 hover:text-amber-700 disabled:border-amber-200 disabled:bg-amber-100 disabled:text-amber-700;
}

.thread-composer-mic-icon {
  @apply h-5 w-5;
}

.thread-composer-mic-spinner {
  @apply h-4.5 w-4.5 rounded-full border-2 border-current border-t-transparent;
  animation: thread-composer-mic-spin 0.8s linear infinite;
}

@keyframes thread-composer-mic-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgb(220 38 38 / 0.32);
  }
  50% {
    box-shadow: 0 0 0 5px rgb(220 38 38 / 0);
  }
}

@keyframes thread-composer-mic-spin {
  to {
    transform: rotate(360deg);
  }
}

.thread-composer-submit {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-0 bg-zinc-900 text-white transition hover:bg-black disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 sm:h-9 sm:w-9;
}

.thread-composer-submit-icon {
  @apply h-4.5 w-4.5 sm:h-5 sm:w-5;
}

.thread-composer-stop {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-0 bg-red-600 text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 sm:h-9 sm:w-9;
}

.thread-composer-stop-icon {
  @apply h-5 w-5;
}

.thread-composer-hidden-input {
  @apply hidden;
}
</style>
