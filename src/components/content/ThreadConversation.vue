<template>
  <section ref="conversationRootRef" class="conversation-root">
    <p v-if="isLoading" class="conversation-loading">Loading messages...</p>

    <p
      v-else-if="messages.length === 0 && pendingRequests.length === 0 && automationProposals.length === 0 && !liveOverlay"
      class="conversation-empty"
    >
      No messages in this thread yet.
    </p>

    <ul v-else ref="conversationListRef" class="conversation-list" @scroll="onConversationScroll">
      <li
        v-if="isLoadingEarlierMessages || earlierLoadError"
        class="conversation-history-control"
        aria-live="polite"
      >
        <div class="conversation-history-status">
          <span v-if="isLoadingEarlierMessages" class="conversation-history-spinner" aria-hidden="true" />
          <span>{{ isLoadingEarlierMessages ? 'Loading earlier messages…' : 'Couldn’t load earlier messages. Scroll up to retry.' }}</span>
        </div>
      </li>

      <li
        v-for="request in pendingRequests"
        :key="`server-request:${request.id}`"
        class="conversation-item conversation-item-request"
      >
        <div class="message-row">
          <div class="message-stack">
            <article class="request-card">
              <p class="request-title">{{ request.method }}</p>
              <p class="request-meta">Request #{{ request.id }} · {{ formatIsoTime(request.receivedAtIso) }}</p>

              <p v-if="readRequestReason(request)" class="request-reason">{{ readRequestReason(request) }}</p>

              <section v-if="request.method === 'item/commandExecution/requestApproval'" class="request-actions">
                <button type="button" class="request-button request-button-primary" @click="onRespondApproval(request.id, 'accept')">Accept</button>
                <button type="button" class="request-button" @click="onRespondApproval(request.id, 'acceptForSession')">Accept for Session</button>
                <button type="button" class="request-button" @click="onRespondApproval(request.id, 'decline')">Decline</button>
                <button type="button" class="request-button" @click="onRespondApproval(request.id, 'cancel')">Cancel</button>
              </section>

              <section v-else-if="request.method === 'item/fileChange/requestApproval'" class="request-actions">
                <button type="button" class="request-button request-button-primary" @click="onRespondApproval(request.id, 'accept')">Accept</button>
                <button type="button" class="request-button" @click="onRespondApproval(request.id, 'acceptForSession')">Accept for Session</button>
                <button type="button" class="request-button" @click="onRespondApproval(request.id, 'decline')">Decline</button>
                <button type="button" class="request-button" @click="onRespondApproval(request.id, 'cancel')">Cancel</button>
              </section>

              <section v-else-if="request.method === 'item/tool/requestUserInput'" class="request-user-input">
                <div
                  v-for="question in readToolQuestions(request)"
                  :key="`${request.id}:${question.id}`"
                  class="request-question"
                >
                  <p class="request-question-title">{{ question.header || question.question }}</p>
                  <p v-if="question.header && question.question" class="request-question-text">{{ question.question }}</p>
                  <select
                    class="request-select"
                    :value="readQuestionAnswer(request.id, question.id, question.options[0] || '')"
                    @change="onQuestionAnswerChange(request.id, question.id, $event)"
                  >
                    <option v-for="option in question.options" :key="`${request.id}:${question.id}:${option}`" :value="option">
                      {{ option }}
                    </option>
                  </select>
                  <input
                    v-if="question.isOther"
                    class="request-input"
                    type="text"
                    :value="readQuestionOtherAnswer(request.id, question.id)"
                    placeholder="Other answer"
                    @input="onQuestionOtherAnswerInput(request.id, question.id, $event)"
                  />
                </div>

                <button type="button" class="request-button request-button-primary" @click="onRespondToolRequestUserInput(request)">
                  Submit Answers
                </button>
              </section>

              <section v-else-if="request.method === 'item/tool/call'" class="request-actions">
                <button type="button" class="request-button request-button-primary" @click="onRespondToolCallFailure(request.id)">Fail Tool Call</button>
                <button type="button" class="request-button" @click="onRespondToolCallSuccess(request.id)">Success (Empty)</button>
              </section>

              <section v-else class="request-actions">
                <button type="button" class="request-button request-button-primary" @click="onRespondEmptyResult(request.id)">Return Empty Result</button>
                <button type="button" class="request-button" @click="onRejectUnknownRequest(request.id)">Reject Request</button>
              </section>
            </article>
          </div>
        </div>
      </li>

      <li
        v-for="proposal in unanchoredResolvedAutomationProposals"
        :key="`automation-proposal-fallback:${proposal.id}`"
        class="conversation-item conversation-item-request"
      >
        <div class="message-row">
          <div class="message-stack">
            <AutomationProposalCard
              :proposal="proposal"
              :task="automationTaskForProposal(proposal)"
              @resolve="onResolveAutomationProposal"
            />
          </div>
        </div>
      </li>

      <template v-for="message in visibleMessages" :key="message.id">
        <li
          class="conversation-item"
          :class="{ 'conversation-item-actionable': canForkMessage(message) || canRollbackMessage(message) }"
          :data-role="message.role"
          :data-message-type="message.messageType || ''"
        >
        <div class="message-row" :data-role="message.role" :data-message-type="message.messageType || ''">
          <div class="message-stack" :data-role="message.role">
            <article class="message-body" :data-role="message.role">
              <ul
                v-if="message.images && message.images.length > 0"
                class="message-image-list"
                :data-role="message.role"
              >
                <li v-for="imageUrl in message.images" :key="imageUrl" class="message-image-item">
                  <button class="message-image-button" type="button" @click="openImageModal(imageUrl)">
                    <img class="message-image-preview" :src="toRenderableImageUrl(imageUrl)" alt="Message image preview" loading="lazy" />
                  </button>
                </li>
              </ul>

              <div v-if="message.fileAttachments && message.fileAttachments.length > 0" class="message-file-attachments">
                <span v-for="att in message.fileAttachments" :key="att.path" class="message-file-chip">
                  <span class="message-file-chip-icon">📄</span>
                  <span class="message-file-chip-name" :title="att.path">{{ att.label }}</span>
                </span>
              </div>

              <details
                v-if="message.responseAnnotations && message.responseAnnotations.length > 0"
                class="message-response-annotations"
              >
                <summary class="message-response-annotations-summary">
                  <MessageSquareQuote class="message-response-annotations-icon" />
                  <span>{{ selectionCountLabel(message.responseAnnotations.length) }}</span>
                </summary>
                <div class="message-response-annotations-list">
                  <blockquote
                    v-for="annotation in message.responseAnnotations"
                    :key="annotation.id"
                    class="message-response-annotation"
                  >
                    <p class="message-response-annotation-quote">{{ annotation.text }}</p>
                    <p v-if="annotation.annotation" class="message-response-annotation-comment">
                      {{ annotation.annotation }}
                    </p>
                  </blockquote>
                </div>
              </details>

              <article v-if="shouldRenderMessageCard(message)" class="message-card" :data-role="message.role">
                <ReviewChangesCard
                  v-if="message.messageType === 'turnDiff' && message.reviewChanges && message.turnId"
                  :changes="message.reviewChanges"
                  :thread-id="activeThreadId"
                  :turn-id="message.turnId"
                  :disabled="isTurnInProgress === true"
                />
                <article
                  v-else-if="message.messageType === 'commandExecution' && message.commandExecution"
                  class="command-card"
                  aria-live="polite"
                >
                  <button
                    type="button"
                    class="cmd-row"
                    :class="[commandStatusClass(message), { 'cmd-expanded': isCommandExpanded(message) }]"
                    @click="toggleCommandExpand(message)"
                  >
                    <span class="cmd-chevron" :class="{ 'cmd-chevron-open': isCommandExpanded(message) }">▶</span>
                    <code class="cmd-label">{{ message.commandExecution.command || '(command)' }}</code>
                    <span class="cmd-status">{{ commandStatusLabel(message) }}</span>
                  </button>
                  <div
                    class="cmd-output-wrap"
                    :class="{ 'cmd-output-visible': isCommandExpanded(message), 'cmd-output-collapsing': isCommandCollapsing(message) }"
                  >
                    <div class="cmd-output-inner">
                      <pre class="cmd-output">{{ message.commandExecution.aggregatedOutput || '(no output)' }}</pre>
                    </div>
                  </div>
                </article>
                <div v-else-if="message.messageType === 'worked'" class="worked-separator-wrap" aria-live="polite">
                  <div class="worked-separator">
                    <span class="worked-separator-line" aria-hidden="true" />
                    <p class="worked-separator-text">{{ message.text }}</p>
                    <span class="worked-separator-line" aria-hidden="true" />
                  </div>
                </div>
                <template v-else>
                  <McpAppResult
                    v-if="message.mcpApp"
                    :result="message.mcpApp"
                    :thread-id="activeThreadId"
                  />
                  <div
                    v-else-if="isToolSummaryMessage(message) && message.toolCall"
                    class="tool-call-row"
                    :class="[toolCallStatusClass(message), toolCallToneClass(message)]"
                  >
                    <span class="tool-call-dot" aria-hidden="true" />
                    <span class="tool-call-label">{{ message.toolCall.label }}</span>
                    <span
                      v-if="message.toolCall.detail || message.toolCall.progress"
                      class="tool-call-meta"
                    >
                      <span v-if="message.toolCall.detail" class="tool-call-detail">{{ message.toolCall.detail }}</span>
                      <span v-if="message.toolCall.progress" class="tool-call-progress">{{ message.toolCall.progress }}</span>
                    </span>
                    <span class="tool-call-status">{{ toolCallStatusLabel(message) }}</span>
                    <p v-if="message.toolCall.description" class="tool-call-description">
                      {{ message.toolCall.description }}
                    </p>
                  </div>
                  <p
                    v-else-if="isToolSummaryMessage(message) && message.text.length > 0"
                    class="message-tool-summary"
                    :class="{ 'message-tool-summary--active': isToolSummaryInProgress(message) }"
                  >
                    {{ message.text }}
                  </p>
                  <div
                    v-else-if="message.text.length > 0 && message.role === 'assistant'"
                    class="message-markdown-content prose prose-slate prose-sm max-w-none"
                    data-response-selection-surface
                    :data-response-message-id="message.id"
                    v-html="renderMarkdown(message.text)"
                    @pointerdown="onResponseSelectionPointerDown($event)"
                    @pointerup="onResponseSelectionPointerUp($event, message)"
                    @keyup="onResponseSelectionKeyUp($event, message)"
                  />
                  <div
                    v-else-if="message.text.length > 0"
                    class="message-markdown-content prose prose-slate prose-sm max-w-none"
                    v-html="renderMarkdown(message.text)"
                  />
                  <details v-if="shouldRenderDetailsPayload(message)" class="message-raw-details">
                    <summary class="message-raw-summary">{{ detailsSummaryLabel(message) }}</summary>
                    <pre class="message-raw-payload">{{ message.rawPayload }}</pre>
                  </details>
                </template>
              </article>
              <p
                v-if="messageDeliveryState(message)"
                class="message-delivery-status"
                :data-state="messageDeliveryState(message)"
                aria-live="polite"
              >
                <span class="message-delivery-dot" aria-hidden="true" />
                <span>{{ messageDeliveryLabel(message) }}</span>
              </p>
            </article>

            <div v-if="canForkMessage(message) || canRollbackMessage(message)" class="message-actions">
              <Button
                v-if="canForkMessage(message)"
                class="message-action-button"
                variant="ghost"
                size="icon-xs"
                type="button"
                title="Continue in new chat"
                aria-label="Continue in new chat from here"
                @click="openForkDialog(message)"
              >
                <IconTablerGitFork class="message-action-icon" />
              </Button>
              <Button
                v-if="canRollbackMessage(message)"
                class="message-action-button"
                variant="ghost"
                size="icon-xs"
                type="button"
                title="Rollback to this message (remove this turn and all after it)"
                aria-label="Rollback to this message"
                @click="onRollback(message)"
              >
                <IconTablerArrowBackUp class="message-action-icon" />
              </Button>
            </div>
          </div>
        </div>
        </li>
        <li
          v-for="proposal in automationProposalsAfterMessage(message)"
          :key="`automation-proposal:${proposal.id}`"
          class="conversation-item conversation-item-request"
        >
          <div class="message-row">
            <div class="message-stack">
              <AutomationProposalCard
                :proposal="proposal"
                :task="automationTaskForProposal(proposal)"
                @resolve="onResolveAutomationProposal"
              />
            </div>
          </div>
        </li>
      </template>
      <li
        v-for="proposal in trailingAutomationProposals"
        :key="`automation-proposal:${proposal.id}`"
        class="conversation-item conversation-item-request"
      >
        <div class="message-row">
          <div class="message-stack">
            <AutomationProposalCard
              :proposal="proposal"
              :task="automationTaskForProposal(proposal)"
              @resolve="onResolveAutomationProposal"
            />
          </div>
        </div>
      </li>
      <li v-if="liveOverlay" class="conversation-item conversation-item-overlay" data-role="assistant">
        <div class="message-row" data-role="assistant">
          <div class="message-stack" data-role="assistant">
            <article class="live-overlay-inline" aria-live="polite">
              <p class="live-overlay-label">
                <span class="live-overlay-dots" aria-hidden="true">
                  <span class="live-overlay-dot" />
                  <span class="live-overlay-dot" />
                  <span class="live-overlay-dot" />
                </span>
                <span class="live-overlay-label-text">{{ liveOverlay.activityLabel }}</span>
              </p>
              <details
                v-if="liveOverlay.reasoningText"
                class="live-overlay-reasoning-details"
              >
                <summary class="live-overlay-reasoning-summary">
                  <span class="live-overlay-reasoning-title">Reasoning</span>
                  <span class="live-overlay-reasoning-preview">{{ compactReasoningPreview(liveOverlay.reasoningText) }}</span>
                </summary>
                <p class="live-overlay-reasoning">
                  {{ liveOverlay.reasoningText }}
                </p>
              </details>
              <p v-if="liveOverlay.errorText" class="live-overlay-error">{{ liveOverlay.errorText }}</p>
            </article>
          </div>
        </div>
      </li>
      <li ref="bottomAnchorRef" class="conversation-bottom-anchor" />
    </ul>
    <Transition name="scroll-bottom-button">
      <button
        v-if="showScrollToBottom && (messages.length > 0 || pendingRequests.length > 0 || automationProposals.length > 0 || !!liveOverlay)"
        class="scroll-bottom-button"
        type="button"
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
        @click="onScrollToBottomClick"
      >
        <IconTablerChevronDown class="scroll-bottom-button-icon" />
      </button>
    </Transition>

    <DialogRoot :open="forkDialogMessage !== null" @update:open="onForkDialogOpenChange">
      <DialogPortal>
        <DialogOverlay class="continue-chat-dialog-overlay" />
        <DialogContent class="continue-chat-dialog" aria-describedby="continue-chat-description">
          <div class="continue-chat-dialog-header">
            <DialogTitle class="continue-chat-dialog-title">Continue in a new chat</DialogTitle>
            <DialogDescription id="continue-chat-description" class="continue-chat-dialog-description">
              Choose whether the new chat should share these files or work in an isolated Git checkout.
            </DialogDescription>
          </div>

          <div class="continue-chat-options">
            <Button
              class="continue-chat-option"
              variant="ghost"
              type="button"
              :disabled="isForkingThread"
              @click="submitFork('workspace')"
            >
              <IconTablerGitFork class="continue-chat-option-icon" />
              <span class="continue-chat-option-copy">
                <span class="continue-chat-option-label">
                  {{ threadHasWorktree ? 'Use this worktree' : 'Use this workspace' }}
                </span>
                <span class="continue-chat-option-description">
                  {{ threadHasWorktree
                    ? 'Continue from this response in the same worktree'
                    : 'Continue from this response in a new local chat' }}
                </span>
              </span>
            </Button>

            <Button
              class="continue-chat-option"
              variant="ghost"
              type="button"
              :disabled="isForkingThread || !threadCwd"
              @click="submitFork('worktree')"
            >
              <IconTablerGitFork class="continue-chat-option-icon" />
              <span class="continue-chat-option-copy">
                <span class="continue-chat-option-label">Use a new worktree</span>
                <span class="continue-chat-option-description">Continue from this response in a new isolated Git worktree</span>
              </span>
            </Button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <Popover
      :open="capturedResponseSelection !== null && responseAnnotationEditor === null && !useDockedResponseSelectionActions"
      @update:open="onResponseSelectionPopoverOpenChange"
    >
      <PopoverAnchor :reference="responseSelectionAnchor" />
      <PopoverContent
        class="response-selection-toolbar"
        data-response-selection-actions
        data-response-selection-mode="desktop"
        align="center"
        side="top"
        :side-offset="7"
        @open-auto-focus="preventPopoverAutoFocus"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="response-selection-toolbar-button"
          data-response-selection-add
          @pointerdown.prevent.stop="openResponseAnnotationEditor"
          @click="openResponseAnnotationEditor"
        >
          <MessageSquarePlus />
          <span>Add to chat</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          class="response-selection-toolbar-dismiss"
          data-response-selection-dismiss
          aria-label="Cancel text selection"
          title="Cancel"
          @pointerdown.prevent.stop
          @click="dismissResponseSelection"
        >
          <IconTablerX aria-hidden="true" />
        </Button>
      </PopoverContent>
    </Popover>

    <Transition name="response-selection-dock">
      <div
        v-if="capturedResponseSelection !== null && responseAnnotationEditor === null && useDockedResponseSelectionActions"
        class="response-selection-dock"
        data-response-selection-actions
        data-response-selection-mode="mobile"
        role="toolbar"
        aria-label="Selected response text actions"
        @pointerdown.stop
      >
        <span class="response-selection-dock-label">
          <MessageSquarePlus aria-hidden="true" />
          <span>Text selected</span>
        </span>
        <Button
          type="button"
          size="sm"
          class="response-selection-dock-add"
          data-response-selection-add
          @pointerdown.prevent.stop="openResponseAnnotationEditor"
          @click="openResponseAnnotationEditor"
        >
          Add to chat
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          class="response-selection-dock-dismiss"
          data-response-selection-dismiss
          aria-label="Cancel text selection"
          title="Cancel"
          @pointerdown.prevent.stop
          @click="dismissResponseSelection"
        >
          <IconTablerX aria-hidden="true" />
        </Button>
      </div>
    </Transition>

    <Popover :open="responseAnnotationEditor !== null" @update:open="onResponseAnnotationPopoverOpenChange">
      <PopoverAnchor :reference="responseAnnotationAnchor" />
      <PopoverContent
        class="response-annotation-popover"
        :class="{ 'response-annotation-popover--compact': useDockedResponseSelectionActions }"
        data-response-annotation-editor
        align="center"
        :side="useDockedResponseSelectionActions ? 'top' : 'bottom'"
        :side-offset="8"
        :collision-padding="8"
        :update-position-strategy="responseAnnotationPositionUpdateStrategy(useDockedResponseSelectionActions)"
      >
        <form class="response-annotation-form" @submit.prevent="addResponseAnnotationToComposer">
          <p class="response-annotation-heading">
            {{ editingResponseAnnotationId ? 'Edit comment' : 'Add to chat' }}
          </p>
          <p class="response-annotation-quote">“{{ responseAnnotationEditor?.text }}”</p>
          <Textarea
            v-model="responseAnnotationDraft"
            aria-label="Note"
            class="response-annotation-input"
            placeholder="Add an optional comment…"
            @keydown="onResponseAnnotationInputKeydown"
          />
          <div class="response-annotation-actions">
            <div class="response-annotation-actions-leading">
              <Button
                v-if="isResponseAnnotationDictationSupported"
                type="button"
                variant="ghost"
                size="icon-sm"
                class="response-annotation-mic"
                :class="{
                  'is-recording': responseAnnotationDictationState === 'recording',
                  'is-transcribing': responseAnnotationDictationState === 'transcribing',
                }"
                :aria-label="responseAnnotationDictationButtonLabel"
                :aria-pressed="responseAnnotationDictationState === 'recording'"
                :title="responseAnnotationDictationButtonLabel"
                :disabled="responseAnnotationDictationState === 'transcribing'"
                @click="toggleResponseAnnotationDictation"
              >
                <span
                  v-if="responseAnnotationDictationState === 'transcribing'"
                  class="response-annotation-mic-spinner"
                  aria-hidden="true"
                />
                <IconTablerMicrophone v-else class="response-annotation-mic-icon" />
              </Button>
              <Button
                v-if="editingResponseAnnotationId"
                type="button"
                variant="ghost"
                size="sm"
                class="response-annotation-delete"
                @click="deleteEditingResponseAnnotation"
              >
                Delete
              </Button>
            </div>
            <div class="response-annotation-actions-trailing">
              <Button type="button" variant="ghost" size="sm" @click="closeResponseAnnotationEditor">
                Cancel
              </Button>
              <Button type="submit" size="sm">
                {{ editingResponseAnnotationId ? 'Save' : 'Add' }}
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>

    <Teleport to="body">
      <div v-if="responseAnnotationMarkers.length > 0" class="response-annotation-marker-layer">
        <button
          v-for="marker in responseAnnotationMarkers"
          :key="marker.id"
          type="button"
          class="response-annotation-marker"
          :class="{
            'is-selected': editingResponseAnnotationId === marker.id || hoveredResponseAnnotationId === marker.id,
          }"
          :style="responseAnnotationMarkerStyle(marker)"
          :aria-label="`Response annotation ${marker.label}`"
          :aria-describedby="marker.annotation.annotation?.trim() ? `response-annotation-preview-${marker.id}` : undefined"
          :data-response-text-annotation-id="marker.id"
          @pointerdown.stop
          @click="openResponseAnnotationMarker(marker.id)"
          @mouseenter="hoveredResponseAnnotationId = marker.id"
          @mouseleave="hoveredResponseAnnotationId = null"
          @focus="hoveredResponseAnnotationId = marker.id"
          @blur="hoveredResponseAnnotationId = null"
        >
          <svg
            class="response-annotation-marker-shape"
            viewBox="0 0 26 25"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12.6504 0.824799C6.21496 0.824799 0.825466 5.77554 0.825195 12.0885C0.825245 14.2375 1.46183 16.2421 2.55176 17.943L2.02148 20.235L1.99316 20.3756C1.77603 21.655 2.78945 22.7791 4.02832 22.7691L4.0791 22.8209L4.53418 22.7047L7.12305 22.0426C8.77593 22.8778 10.6577 23.3531 12.6504 23.3531C19.086 23.3531 24.4754 18.4014 24.4756 12.0885C24.4753 5.77554 19.0858 0.824799 12.6504 0.824799Z"
              fill="currentColor"
              stroke="white"
              stroke-width="1.65"
            />
          </svg>
          <span class="response-annotation-marker-label" aria-hidden="true">{{ marker.label }}</span>
        </button>

        <div
          v-if="responseAnnotationMarkerPreview"
          :id="`response-annotation-preview-${responseAnnotationMarkerPreview.id}`"
          class="response-annotation-marker-preview"
          :style="responseAnnotationMarkerPreviewStyle(responseAnnotationMarkerPreview)"
          role="tooltip"
        >
          {{ responseAnnotationMarkerPreview.annotation.annotation }}
        </div>
      </div>
    </Teleport>

    <div v-if="modalImageUrl.length > 0" class="image-modal-backdrop" @click="closeImageModal">
      <div class="image-modal-content" @click.stop>
        <button class="image-modal-close" type="button" aria-label="Close image preview" @click="closeImageModal">
          <IconTablerX class="icon-svg" />
        </button>
        <img class="image-modal-image" :src="modalImageUrl" alt="Expanded message image" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import '@fontsource-variable/inter'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import markdownit from 'markdown-it'
import { MessageSquarePlus, MessageSquareQuote } from '@lucide/vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import type {
  ResponseTextAnnotation,
  ThreadScrollState,
  UiLiveOverlay,
  UiMessage,
  UiServerRequest,
} from '../../types/codex'
import type { AutomationProposal, AutomationTask } from '../../types/automations'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useDictation } from '../../composables/useDictation'
import { useComposerDraftStore } from '../../stores/composerDrafts'
import {
  shouldFollowConversationBottom,
  shouldForceThreadOpenToBottom,
} from '../../utils/threadScroll'
import {
  normalizeResponseSelectionPointerType,
  responseAnnotationPositionUpdateStrategy,
  responseSelectionPointerDownAction,
  responseSelectionSettleDelay,
  shouldCaptureResponseSelectionAfterPointerUp,
  shouldUseDockedResponseSelectionActions,
} from '../../utils/responseSelection'
import type { ResponseSelectionPointerType } from '../../utils/responseSelection'
import IconTablerX from '../icons/IconTablerX.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerArrowBackUp from '../icons/IconTablerArrowBackUp.vue'
import IconTablerMicrophone from '../icons/IconTablerMicrophone.vue'
import IconTablerGitFork from '../icons/IconTablerGitFork.vue'
import AutomationProposalCard from './AutomationProposalCard.vue'
import McpAppResult from './McpAppResult.vue'
import ReviewChangesCard from './ReviewChangesCard.vue'

const md = markdownit({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
})
const LIVE_REASONING_PREVIEW_MAX_CHARS = 180

type CapturedResponseSelection = {
  messageId: string
  text: string
  range: Range
  rect: DOMRect
}

type ResponseAnnotationMarker = {
  id: string
  label: number
  left: number
  top: number
  annotation: ResponseTextAnnotation
}

const defaultImageRenderer = md.renderer.rules.image ?? ((tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options))
const defaultLinkOpenRenderer = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options))

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const srcIndex = token.attrIndex('src')
  if (srcIndex >= 0) {
    token.attrs![srcIndex]![1] = toRenderableImageUrl(token.attrs![srcIndex]![1] ?? '')
  }
  token.attrSet('loading', 'lazy')
  return defaultImageRenderer(tokens, idx, options, env, self)
}

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noreferrer noopener')
  return defaultLinkOpenRenderer(tokens, idx, options, env, self)
}

function renderMarkdown(text: string): string {
  if (!text) return ''
  return md.render(normalizeMarkdownText(text))
}

function normalizeMarkdownText(text: string): string {
  return text.replace(/\\(`+)([^`\n]*?)\\\1/gu, '$1$2$1')
}

function compactReasoningPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= LIVE_REASONING_PREVIEW_MAX_CHARS) return normalized
  return `${normalized.slice(0, LIVE_REASONING_PREVIEW_MAX_CHARS).trimEnd()}...`
}

function shouldRenderMessageCard(message: UiMessage): boolean {
  if (message.messageType === 'commandExecution' && message.commandExecution) return true
  return Boolean(message.reviewChanges) || Boolean(message.mcpApp) || Boolean(message.toolCall) || message.text.length > 0 || shouldRenderDetailsPayload(message)
}

function messageDeliveryState(message: UiMessage): 'pending' | 'sent' | 'failed' | '' {
  if (message.messageType === 'userMessage.steering') return 'pending'
  if (message.messageType === 'userMessage.steered') return 'sent'
  if (message.messageType === 'userMessage.failed') return 'failed'
  return ''
}

function messageDeliveryLabel(message: UiMessage): string {
  const state = messageDeliveryState(message)
  if (state === 'pending') return 'Steering…'
  if (state === 'sent') return 'Sent to current turn'
  if (state === 'failed') return 'Couldn’t steer'
  return ''
}

function shouldDisplayMessage(message: UiMessage): boolean {
  if (!isToolSummaryMessage(message)) return true
  if (!message.toolCall) return message.text.trim().length > 0
  if (message.mcpApp) return true
  if (
    message.toolCall.status === 'failed' &&
    message.toolCall.tone === 'warning' &&
    message.toolCall.statusLabel !== 'Connection issue'
  ) {
    return false
  }
  return message.toolCall.status !== 'completed'
}

function isToolSummaryMessage(message: UiMessage): boolean {
  const type = message.messageType ?? ''
  return type === 'mcpToolCall' || type === 'webSearch' || type === 'collabAgentToolCall'
}

function isToolSummaryInProgress(message: UiMessage): boolean {
  if (!isToolSummaryMessage(message)) return false
  if (message.toolCall) return message.toolCall.status === 'inProgress'
  const normalizedText = message.text.trim().toLowerCase()
  return (
    normalizedText.startsWith('calling ') ||
    normalizedText.startsWith('running ') ||
    normalizedText.startsWith('searching ')
  )
}

function shouldRenderDetailsPayload(message: UiMessage): boolean {
  if (!message.rawPayload || message.rawPayload.length === 0) return false
  if (isToolSummaryMessage(message)) return false
  return message.isUnhandled === true
}

function detailsSummaryLabel(message: UiMessage): string {
  return 'Details'
}

function toolCallStatusLabel(message: UiMessage): string {
  const customLabel = message.toolCall?.statusLabel?.trim()
  if (customLabel) return customLabel
  const status = message.toolCall?.status
  if (status === 'inProgress') return 'Running'
  if (status === 'failed') return 'Failed'
  return 'Done'
}

function toolCallStatusClass(message: UiMessage): string {
  const status = message.toolCall?.status
  if (status === 'inProgress') return 'tool-call-row--active'
  if (status === 'failed') return 'tool-call-row--failed'
  return 'tool-call-row--done'
}

function toolCallToneClass(message: UiMessage): string {
  if (message.toolCall?.tone === 'warning') return 'tool-call-row--warning'
  if (message.toolCall?.tone === 'error') return 'tool-call-row--error'
  return ''
}

const expandedCommandIds = ref<Set<string>>(new Set())
const collapsingCommandIds = ref<Set<string>>(new Set())
const prevCommandStatuses = ref<Record<string, string>>({})

function isCommandExpanded(message: UiMessage): boolean {
  if (message.commandExecution?.status === 'inProgress') return true
  if (collapsingCommandIds.value.has(message.id)) return true
  return expandedCommandIds.value.has(message.id)
}

function isCommandCollapsing(message: UiMessage): boolean {
  return collapsingCommandIds.value.has(message.id)
}

function toggleCommandExpand(message: UiMessage): void {
  if (message.commandExecution?.status === 'inProgress') return
  const next = new Set(expandedCommandIds.value)
  if (next.has(message.id)) next.delete(message.id)
  else next.add(message.id)
  expandedCommandIds.value = next
}

function commandStatusLabel(message: UiMessage): string {
  const ce = message.commandExecution
  if (!ce) return ''
  switch (ce.status) {
    case 'inProgress': return '⟳ Running'
    case 'completed': return ce.exitCode === 0 ? '✓ Completed' : `✗ Exit ${ce.exitCode ?? '?'}`
    case 'failed': return '✗ Failed'
    case 'declined': return '⊘ Declined'
    case 'interrupted': return '⊘ Interrupted'
    default: return ''
  }
}

function commandStatusClass(message: UiMessage): string {
  const s = message.commandExecution?.status
  if (s === 'inProgress') return 'cmd-status-running'
  if (s === 'completed' && message.commandExecution?.exitCode === 0) return 'cmd-status-ok'
  return 'cmd-status-error'
}

function scheduleCollapse(messageId: string): void {
  const nextCollapsing = new Set(collapsingCommandIds.value)
  nextCollapsing.add(messageId)
  collapsingCommandIds.value = nextCollapsing
  setTimeout(() => {
    const next = new Set(collapsingCommandIds.value)
    next.delete(messageId)
    collapsingCommandIds.value = next
  }, 1000)
}

const props = defineProps<{
  messages: UiMessage[]
  pendingRequests: UiServerRequest[]
  liveOverlay: UiLiveOverlay | null
  isLoading: boolean
  activeThreadId: string
  scrollState: ThreadScrollState | null
  isTurnInProgress?: boolean
  isForkingThread?: boolean
  isRollingBack?: boolean
  threadCwd?: string
  threadHasWorktree?: boolean
  automationProposals: AutomationProposal[]
  automationTasks: AutomationTask[]
  hasEarlierMessages?: boolean
  isLoadingEarlierMessages?: boolean
  earlierLoadError?: string
}>()

const emit = defineEmits<{
  updateScrollState: [payload: { threadId: string; state: ThreadScrollState }]
  respondServerRequest: [payload: { id: number; result?: unknown; error?: { code?: number; message: string } }]
  rollback: [payload: { turnIndex: number }]
  fork: [payload: { turnIndex: number; target: 'workspace' | 'worktree' }]
  addResponseAnnotation: [annotation: ResponseTextAnnotation]
  'resolve-automation-proposal': [id: string, accept: boolean]
  loadEarlier: []
}>()

function automationTaskForProposal(proposal: AutomationProposal): AutomationTask | undefined {
  const taskId = proposal.resolvedAutomationId || proposal.automationId
  return props.automationTasks.find((task) => task.id === taskId)
}

function onResolveAutomationProposal(id: string, accept: boolean): void {
  emit('resolve-automation-proposal', id, accept)
}

const conversationRootRef = ref<HTMLElement | null>(null)
const conversationListRef = ref<HTMLElement | null>(null)
const bottomAnchorRef = ref<HTMLElement | null>(null)
const modalImageUrl = ref('')
const showScrollToBottom = ref(false)
const toolQuestionAnswers = ref<Record<string, string>>({})
const toolQuestionOtherAnswers = ref<Record<string, string>>({})
const capturedResponseSelection = ref<CapturedResponseSelection | null>(null)
const responseAnnotationEditor = ref<CapturedResponseSelection | null>(null)
const responseAnnotationDraft = ref('')
const editingResponseAnnotationId = ref<string | null>(null)
const hoveredResponseAnnotationId = ref<string | null>(null)
const forkDialogMessage = ref<UiMessage | null>(null)
const hasCoarsePointer = ref(false)
const responseSelectionPointerType = ref<ResponseSelectionPointerType>('')
const responseAnnotationMarkers = ref<ResponseAnnotationMarker[]>([])
const responseAnnotationAnchors = new Map<string, CapturedResponseSelection>()
const composerDraftStore = useComposerDraftStore()
const responseTextAnnotations = computed(() =>
  composerDraftStore.draftFor(props.activeThreadId).responseTextAnnotations,
)
function updateResponseAnnotation(annotationId: string, annotation: string): void {
  composerDraftStore.updateResponseAnnotation(props.activeThreadId, annotationId, annotation)
}
const {
  state: responseAnnotationDictationState,
  isSupported: isResponseAnnotationDictationSupported,
  startRecording: startResponseAnnotationRecording,
  stopRecording: stopResponseAnnotationRecording,
  cancelRecording: cancelResponseAnnotationRecording,
} = useDictation({
  onTranscript: (text) => {
    if (!responseAnnotationEditor.value) return
    responseAnnotationDraft.value = responseAnnotationDraft.value
      ? `${responseAnnotationDraft.value}\n${text}`
      : text
    void nextTick(() => {
      document.querySelector<HTMLTextAreaElement>('.response-annotation-input')?.focus()
    })
  },
})
const responseAnnotationDictationButtonLabel = computed(() => {
  if (responseAnnotationDictationState.value === 'recording') return 'Stop dictation'
  if (responseAnnotationDictationState.value === 'transcribing') return 'Transcribing'
  return 'Dictate comment'
})
const responseAnnotationMarkerPreview = computed(() => {
  if (!hoveredResponseAnnotationId.value || responseAnnotationEditor.value) return null
  const marker = responseAnnotationMarkers.value.find((item) => item.id === hoveredResponseAnnotationId.value)
  return marker?.annotation.annotation?.trim() ? marker : null
})
const useDockedResponseSelectionActions = computed(() =>
  shouldUseDockedResponseSelectionActions(
    hasCoarsePointer.value,
    responseSelectionPointerType.value,
  ),
)
const visibleMessages = computed(() => {
  const supersededAppMessageIds = new Set<string>()
  const latestAppMessageByTurnAndResource = new Map<string, string>()
  for (const message of props.messages) {
    if (!message.mcpApp) continue
    const key = `${message.turnId ?? ''}\u0000${message.mcpApp.server}\u0000${message.mcpApp.resourceUri}`
    const previousMessageId = latestAppMessageByTurnAndResource.get(key)
    if (previousMessageId) supersededAppMessageIds.add(previousMessageId)
    latestAppMessageByTurnAndResource.set(key, message.id)
  }
  return props.messages.filter((message) =>
    !supersededAppMessageIds.has(message.id) && shouldDisplayMessage(message),
  )
})
const automationProposalsByAnchorMessageId = computed(() => {
  const lastMessageIdByTurnId = new Map<string, string>()
  for (const message of visibleMessages.value) {
    if (message.turnId) lastMessageIdByTurnId.set(message.turnId, message.id)
  }

  const proposalsByMessageId = new Map<string, AutomationProposal[]>()
  for (const proposal of props.automationProposals) {
    if (!proposal.turnId) continue
    const messageId = lastMessageIdByTurnId.get(proposal.turnId)
    if (!messageId) continue
    const proposals = proposalsByMessageId.get(messageId)
    if (proposals) proposals.push(proposal)
    else proposalsByMessageId.set(messageId, [proposal])
  }
  return proposalsByMessageId
})
const anchoredAutomationProposalIds = computed(() => new Set(
  [...automationProposalsByAnchorMessageId.value.values()].flat().map((proposal) => proposal.id),
))
const trailingAutomationProposals = computed(() => props.automationProposals.filter((proposal) =>
  proposal.status === 'pending' && !anchoredAutomationProposalIds.value.has(proposal.id),
))
const unanchoredResolvedAutomationProposals = computed(() => props.automationProposals.filter((proposal) =>
  proposal.status !== 'pending' && !anchoredAutomationProposalIds.value.has(proposal.id),
))

function automationProposalsAfterMessage(message: UiMessage): AutomationProposal[] {
  return automationProposalsByAnchorMessageId.value.get(message.id) ?? []
}
const responseSelectionAnchor = computed(() => createSelectionAnchor(capturedResponseSelection.value))
const responseAnnotationAnchor = computed(() => {
  if (useDockedResponseSelectionActions.value) {
    return createDockedResponseSelectionAnchor() ?? createSelectionAnchor(responseAnnotationEditor.value)
  }
  return createSelectionAnchor(responseAnnotationEditor.value)
})
const BOTTOM_THRESHOLD_PX = 16
const BOTTOM_RESET_THRESHOLD_PX = 20
const SCROLL_DIRECTION_THRESHOLD_PX = 2
const EARLIER_MESSAGES_THRESHOLD_PX = 180

let scrollRestoreFrame = 0
let bottomLockFrame = 0
let responseAnnotationMarkerFrame = 0
let responseSelectionFrame = 0
let responseSelectionSettleTimer = 0
let bottomLockFramesLeft = 0
let lastScrollTop = 0
let userHasScrolledAwayFromBottom = false
let responseSelectionPointerIsDown = false
let responseSelectionChangedWhilePointerDown = false
let coarsePointerMediaQuery: MediaQueryList | null = null
let pendingPrependAnchor: {
  threadId: string
  scrollHeight: number
  scrollTop: number
} | null = null
const trackedPendingImages = new WeakSet<HTMLImageElement>()

function createSelectionAnchor(selection: CapturedResponseSelection | null): { getBoundingClientRect: () => DOMRect } | undefined {
  if (!selection) return undefined
  return {
    getBoundingClientRect: () => {
      try {
        const nextRect = selection.range.getBoundingClientRect()
        if (nextRect.width > 0 || nextRect.height > 0) return nextRect
      } catch {
        // The saved rectangle remains a stable fallback if the message rerenders.
      }
      return selection.rect
    },
  }
}

function createDockedResponseSelectionAnchor(): { getBoundingClientRect: () => DOMRect } | undefined {
  const root = conversationRootRef.value
  if (!root) return undefined
  return {
    getBoundingClientRect: () => {
      const rect = root.getBoundingClientRect()
      return DOMRect.fromRect({
        x: rect.left + rect.width / 2,
        y: rect.bottom - 8,
        width: 0,
        height: 0,
      })
    },
  }
}

function selectionCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'selection' : 'selections'}`
}

function readResponseSelection(surface: HTMLElement, message: UiMessage): CapturedResponseSelection | null {
  const selection = surface.ownerDocument.defaultView?.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) return null

  const text = selection.toString().trim()
  if (!text) return null

  const rect = range.getBoundingClientRect()
  if (rect.width <= 0 && rect.height <= 0) return null

  return {
    messageId: message.id,
    text,
    range: range.cloneRange(),
    rect: DOMRect.fromRect(rect),
  }
}

function cancelScheduledResponseSelectionUpdate(): void {
  if (responseSelectionSettleTimer) {
    window.clearTimeout(responseSelectionSettleTimer)
    responseSelectionSettleTimer = 0
  }
  if (responseSelectionFrame) {
    cancelAnimationFrame(responseSelectionFrame)
    responseSelectionFrame = 0
  }
}

function scheduleResponseSelectionUpdate(callback: () => void, delayMs = 0): void {
  cancelScheduledResponseSelectionUpdate()
  const scheduleFrame = () => {
    responseSelectionSettleTimer = 0
    responseSelectionFrame = requestAnimationFrame(() => {
      responseSelectionFrame = 0
      if (!responseAnnotationEditor.value) callback()
    })
  }
  if (delayMs > 0) {
    responseSelectionSettleTimer = window.setTimeout(scheduleFrame, delayMs)
    return
  }
  scheduleFrame()
}

function clearCapturedResponseSelection(): void {
  cancelScheduledResponseSelectionUpdate()
  capturedResponseSelection.value = null
}

function responseSelectionSurfaceForRange(range: Range): HTMLElement | null {
  const startElement = range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement
  const surface = startElement?.closest<HTMLElement>('[data-response-selection-surface]') ?? null
  if (!surface || !surface.contains(range.endContainer)) return null
  return surface
}

function updateResponseSelectionFromDocument(): void {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    capturedResponseSelection.value = null
    return
  }
  const range = selection.getRangeAt(0)
  const surface = responseSelectionSurfaceForRange(range)
  const messageId = surface?.dataset.responseMessageId
  const message = messageId
    ? visibleMessages.value.find((item) => item.id === messageId)
    : undefined
  capturedResponseSelection.value = surface && message
    ? readResponseSelection(surface, message)
    : null
}

function updateResponseSelection(surface: HTMLElement, message: UiMessage): void {
  if (responseAnnotationEditor.value) return
  capturedResponseSelection.value = readResponseSelection(surface, message)
}

function onResponseSelectionPointerDown(event: PointerEvent): void {
  responseSelectionPointerType.value = normalizeResponseSelectionPointerType(event.pointerType)
  responseSelectionPointerIsDown = true
  responseSelectionChangedWhilePointerDown = false
  clearCapturedResponseSelection()
}

function onResponseSelectionPointerUp(event: PointerEvent, message: UiMessage): void {
  const surface = event.currentTarget
  if (!(surface instanceof HTMLElement)) return
  responseSelectionPointerType.value = normalizeResponseSelectionPointerType(event.pointerType)
  const selectionChanged = responseSelectionChangedWhilePointerDown
  responseSelectionPointerIsDown = false
  responseSelectionChangedWhilePointerDown = false
  if (!shouldCaptureResponseSelectionAfterPointerUp(selectionChanged)) return
  scheduleResponseSelectionUpdate(
    () => updateResponseSelection(surface, message),
    responseSelectionSettleDelay(useDockedResponseSelectionActions.value),
  )
}

function onResponseSelectionKeyUp(event: KeyboardEvent, message: UiMessage): void {
  const surface = event.currentTarget
  if (!(surface instanceof HTMLElement)) return
  responseSelectionPointerType.value = ''
  scheduleResponseSelectionUpdate(() => updateResponseSelection(surface, message))
}

function preventPopoverAutoFocus(event: Event): void {
  event.preventDefault()
}

function dismissResponseSelection(): void {
  responseSelectionPointerIsDown = false
  responseSelectionChangedWhilePointerDown = false
  clearCapturedResponseSelection()
  window.getSelection()?.removeAllRanges()
}

function onResponseSelectionPopoverOpenChange(open: boolean): void {
  if (!open && capturedResponseSelection.value && !responseAnnotationEditor.value) {
    dismissResponseSelection()
  }
}

function openResponseAnnotationEditor(): void {
  const selection = capturedResponseSelection.value
  if (!selection) return
  cancelScheduledResponseSelectionUpdate()
  responseAnnotationEditor.value = {
    ...selection,
    range: selection.range.cloneRange(),
    rect: DOMRect.fromRect(selection.rect),
  }
  editingResponseAnnotationId.value = null
  responseAnnotationDraft.value = ''
  capturedResponseSelection.value = null
  window.getSelection()?.removeAllRanges()
}

function closeResponseAnnotationEditor(): void {
  cancelResponseAnnotationRecording()
  responseAnnotationEditor.value = null
  editingResponseAnnotationId.value = null
  responseAnnotationDraft.value = ''
  dismissResponseSelection()
}

function onResponseAnnotationPopoverOpenChange(open: boolean): void {
  if (!open && responseAnnotationEditor.value) closeResponseAnnotationEditor()
}

function createResponseAnnotationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `response-annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function addResponseAnnotationToComposer(): void {
  const selection = responseAnnotationEditor.value
  if (!selection) return
  const annotation = responseAnnotationDraft.value.trim()
  const editingAnnotationId = editingResponseAnnotationId.value
  if (editingAnnotationId) {
    updateResponseAnnotation(editingAnnotationId, annotation)
    closeResponseAnnotationEditor()
    scheduleResponseAnnotationMarkerUpdate()
    return
  }

  const annotationId = createResponseAnnotationId()
  responseAnnotationAnchors.set(annotationId, {
    ...selection,
    range: selection.range.cloneRange(),
    rect: DOMRect.fromRect(selection.rect),
  })
  emit('addResponseAnnotation', {
    id: annotationId,
    text: selection.text,
    ...(annotation ? { annotation } : {}),
    sourceMessageId: selection.messageId,
  })
  closeResponseAnnotationEditor()
  scheduleResponseAnnotationMarkerUpdate()
}

function deleteEditingResponseAnnotation(): void {
  const annotationId = editingResponseAnnotationId.value
  if (!annotationId) return
  composerDraftStore.removeResponseAnnotation(props.activeThreadId, annotationId)
  closeResponseAnnotationEditor()
  scheduleResponseAnnotationMarkerUpdate()
}

function openResponseAnnotationMarker(annotationId: string): void {
  const anchor = responseAnnotationAnchors.get(annotationId)
  const annotation = responseTextAnnotations.value.find((item) => item.id === annotationId)
  if (!anchor || !annotation) return
  cancelScheduledResponseSelectionUpdate()
  editingResponseAnnotationId.value = annotationId
  hoveredResponseAnnotationId.value = null
  capturedResponseSelection.value = null
  responseAnnotationEditor.value = {
    ...anchor,
    range: anchor.range.cloneRange(),
    rect: DOMRect.fromRect(anchor.rect),
  }
  responseAnnotationDraft.value = annotation.annotation ?? ''
  window.getSelection()?.removeAllRanges()
  void nextTick(() => {
    document.querySelector<HTMLTextAreaElement>('.response-annotation-input')?.focus()
  })
}

function responseAnnotationMarkerStyle(marker: ResponseAnnotationMarker): Record<string, string> {
  return {
    left: `${marker.left}px`,
    top: `${marker.top}px`,
  }
}

function responseAnnotationMarkerPreviewStyle(marker: ResponseAnnotationMarker): Record<string, string> {
  const previewHalfWidth = 147
  const left = Math.min(
    Math.max(marker.left, 16 + previewHalfWidth),
    Math.max(16 + previewHalfWidth, window.innerWidth - 16 - previewHalfWidth),
  )
  const top = marker.top >= 60 ? marker.top - 44 : marker.top + 27
  return {
    left: `${left}px`,
    top: `${top}px`,
    transform: 'translateX(-50%)',
  }
}

function updateResponseAnnotationMarkers(): void {
  const scrollContainer = conversationListRef.value
  if (!scrollContainer || responseTextAnnotations.value.length === 0) {
    responseAnnotationMarkers.value = []
    return
  }

  const clipRect = scrollContainer.getBoundingClientRect()
  responseAnnotationMarkers.value = responseTextAnnotations.value.flatMap((annotation, index) => {
    const anchor = responseAnnotationAnchors.get(annotation.id)
    if (!anchor || !anchor.range.commonAncestorContainer.isConnected) return []

    const visibleRects = Array.from(anchor.range.getClientRects()).filter((rect) => {
      const midpointY = rect.top + rect.height / 2
      return rect.width > 0
        && rect.height > 0
        && rect.right >= clipRect.left
        && rect.right <= clipRect.right
        && midpointY >= clipRect.top
        && midpointY <= clipRect.bottom
    })
    if (visibleRects.length === 0) return []

    return [{
      id: annotation.id,
      label: index + 1,
      left: Math.min(window.innerWidth - 12.5, Math.max(12.5, ...visibleRects.map((rect) => rect.right))),
      top: Math.max(12.5, Math.min(...visibleRects.map((rect) => rect.top)) - 12.5),
      annotation,
    }]
  })
}

function scheduleResponseAnnotationMarkerUpdate(): void {
  if (responseAnnotationMarkerFrame) return
  responseAnnotationMarkerFrame = requestAnimationFrame(() => {
    responseAnnotationMarkerFrame = 0
    updateResponseAnnotationMarkers()
  })
}

function onResponseAnnotationInputKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.key !== 'Enter' || event.shiftKey || event.altKey) return
  event.preventDefault()
  addResponseAnnotationToComposer()
}

function toggleResponseAnnotationDictation(): void {
  if (responseAnnotationDictationState.value === 'transcribing') return
  if (responseAnnotationDictationState.value === 'recording') {
    stopResponseAnnotationRecording()
    return
  }
  void startResponseAnnotationRecording()
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const action = responseSelectionPointerDownAction({
    isInteractiveTarget: Boolean(target.closest(
      '[data-response-selection-actions], [data-response-annotation-editor], .response-annotation-marker',
    )),
    hasAnnotationEditor: responseAnnotationEditor.value !== null,
    isResponseSurface: Boolean(target.closest('[data-response-selection-surface]')),
    hasCapturedSelection: capturedResponseSelection.value !== null,
  })
  if (action === 'close-editor') {
    closeResponseAnnotationEditor()
    return
  }
  // iOS selection handles target the underlying response content. Let the
  // surface handler hide our dock and track the drag without clearing the range.
  if (action === 'dismiss-selection') dismissResponseSelection()
}

function onDocumentPointerUp(): void {
  if (!responseSelectionPointerIsDown) return
  const selectionChanged = responseSelectionChangedWhilePointerDown
  responseSelectionPointerIsDown = false
  responseSelectionChangedWhilePointerDown = false
  if (!shouldCaptureResponseSelectionAfterPointerUp(selectionChanged)) return
  scheduleResponseSelectionUpdate(
    updateResponseSelectionFromDocument,
    responseSelectionSettleDelay(useDockedResponseSelectionActions.value),
  )
}

function onDocumentPointerCancel(): void {
  responseSelectionPointerIsDown = false
  responseSelectionChangedWhilePointerDown = false
  scheduleResponseSelectionUpdate(
    updateResponseSelectionFromDocument,
    responseSelectionSettleDelay(useDockedResponseSelectionActions.value),
  )
}

function onDocumentSelectionChange(): void {
  if (responseAnnotationEditor.value) return
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    clearCapturedResponseSelection()
    return
  }
  if (responseSelectionPointerIsDown) {
    responseSelectionChangedWhilePointerDown = true
    return
  }
  scheduleResponseSelectionUpdate(
    updateResponseSelectionFromDocument,
    responseSelectionSettleDelay(useDockedResponseSelectionActions.value),
  )
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || (!capturedResponseSelection.value && !responseAnnotationEditor.value)) return
  event.preventDefault()
  event.stopPropagation()
  if (responseAnnotationEditor.value) closeResponseAnnotationEditor()
  else dismissResponseSelection()
}

function syncCoarsePointerPreference(event?: MediaQueryListEvent): void {
  hasCoarsePointer.value = event?.matches ?? coarsePointerMediaQuery?.matches ?? false
}

type ParsedToolQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  options: string[]
}

function toRenderableImageUrl(value: string): string {
  const normalized = value.trim()
  if (!normalized) return ''
  if (
    normalized.startsWith('data:') ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('/codex-local-image?')
  ) {
    return normalized
  }

  if (normalized.startsWith('file://')) {
    return `/codex-local-image?path=${encodeURIComponent(normalized)}`
  }

  const looksLikeUnixAbsolute = normalized.startsWith('/')
  const looksLikeWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(normalized)
  if (looksLikeUnixAbsolute || looksLikeWindowsAbsolute) {
    return `/codex-local-image?path=${encodeURIComponent(normalized)}`
  }

  return normalized
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function formatIsoTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString()
}

function readRequestReason(request: UiServerRequest): string {
  const params = asRecord(request.params)
  const reason = params?.reason
  return typeof reason === 'string' ? reason.trim() : ''
}

function toolQuestionKey(requestId: number, questionId: string): string {
  return `${String(requestId)}:${questionId}`
}

function readToolQuestions(request: UiServerRequest): ParsedToolQuestion[] {
  const params = asRecord(request.params)
  const questions = Array.isArray(params?.questions) ? params.questions : []
  const parsed: ParsedToolQuestion[] = []

  for (const row of questions) {
    const question = asRecord(row)
    if (!question) continue
    const id = typeof question.id === 'string' ? question.id : ''
    if (!id) continue

    const options = Array.isArray(question.options)
      ? question.options
        .map((option) => asRecord(option))
        .map((option) => option?.label)
        .filter((option): option is string => typeof option === 'string' && option.length > 0)
      : []

    parsed.push({
      id,
      header: typeof question.header === 'string' ? question.header : '',
      question: typeof question.question === 'string' ? question.question : '',
      isOther: question.isOther === true,
      options,
    })
  }

  return parsed
}

function readQuestionAnswer(requestId: number, questionId: string, fallback: string): string {
  const key = toolQuestionKey(requestId, questionId)
  const saved = toolQuestionAnswers.value[key]
  if (typeof saved === 'string' && saved.length > 0) return saved
  return fallback
}

function readQuestionOtherAnswer(requestId: number, questionId: string): string {
  const key = toolQuestionKey(requestId, questionId)
  return toolQuestionOtherAnswers.value[key] ?? ''
}

function onQuestionAnswerChange(requestId: number, questionId: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const key = toolQuestionKey(requestId, questionId)
  toolQuestionAnswers.value = {
    ...toolQuestionAnswers.value,
    [key]: target.value,
  }
}

function onQuestionOtherAnswerInput(requestId: number, questionId: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const key = toolQuestionKey(requestId, questionId)
  toolQuestionOtherAnswers.value = {
    ...toolQuestionOtherAnswers.value,
    [key]: target.value,
  }
}

function onRespondApproval(requestId: number, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): void {
  emit('respondServerRequest', {
    id: requestId,
    result: { decision },
  })
}

function onRespondToolRequestUserInput(request: UiServerRequest): void {
  const questions = readToolQuestions(request)
  const answers: Record<string, { answers: string[] }> = {}

  for (const question of questions) {
    const selected = readQuestionAnswer(request.id, question.id, question.options[0] || '')
    const other = readQuestionOtherAnswer(request.id, question.id).trim()
    const values = [selected, other].map((value) => value.trim()).filter((value) => value.length > 0)
    answers[question.id] = { answers: values }
  }

  emit('respondServerRequest', {
    id: request.id,
    result: { answers },
  })
}

function onRespondToolCallFailure(requestId: number): void {
  emit('respondServerRequest', {
    id: requestId,
    result: {
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: 'Tool call rejected from codex-web-local UI.',
        },
      ],
    },
  })
}

function onRespondToolCallSuccess(requestId: number): void {
  emit('respondServerRequest', {
    id: requestId,
    result: {
      success: true,
      contentItems: [],
    },
  })
}

function onRespondEmptyResult(requestId: number): void {
  emit('respondServerRequest', {
    id: requestId,
    result: {},
  })
}

function onRejectUnknownRequest(requestId: number): void {
  emit('respondServerRequest', {
    id: requestId,
    error: {
      code: -32000,
      message: 'Rejected from codex-web-local UI.',
    },
  })
}

function canRollbackMessage(message: UiMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false
  if (typeof message.turnIndex !== 'number') return false
  if (props.isTurnInProgress || props.isRollingBack) return false
  return true
}

function canForkMessage(message: UiMessage): boolean {
  if (message.role !== 'assistant') return false
  if (typeof message.turnIndex !== 'number') return false
  if (props.isTurnInProgress || props.isRollingBack || props.isForkingThread) return false
  return true
}

function openForkDialog(message: UiMessage): void {
  if (!canForkMessage(message)) return
  forkDialogMessage.value = message
}

function onForkDialogOpenChange(open: boolean): void {
  if (!open && !props.isForkingThread) forkDialogMessage.value = null
}

function submitFork(target: 'workspace' | 'worktree'): void {
  const message = forkDialogMessage.value
  if (!message || typeof message.turnIndex !== 'number' || props.isForkingThread) return
  emit('fork', { turnIndex: message.turnIndex, target })
  forkDialogMessage.value = null
}

function onRollback(message: UiMessage): void {
  if (!canRollbackMessage(message)) return
  emit('rollback', { turnIndex: message.turnIndex! })
}

function scrollToBottom(): void {
  const container = conversationListRef.value
  const anchor = bottomAnchorRef.value
  if (!container || !anchor) return
  container.scrollTop = container.scrollHeight
  anchor.scrollIntoView({ block: 'end' })
}

function isAtBottom(container: HTMLElement): boolean {
  const distance = container.scrollHeight - (container.scrollTop + container.clientHeight)
  return distance <= BOTTOM_THRESHOLD_PX
}

function distanceFromBottom(container: HTMLElement): number {
  return container.scrollHeight - (container.scrollTop + container.clientHeight)
}

function cancelBottomLock(): void {
  bottomLockFramesLeft = 0
  if (!bottomLockFrame) return
  cancelAnimationFrame(bottomLockFrame)
  bottomLockFrame = 0
}

function emitScrollState(container: HTMLElement): void {
  if (!props.activeThreadId) return
  const atBottom = isAtBottom(container)
  showScrollToBottom.value = !atBottom
  const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0)
  const scrollRatio = maxScrollTop > 0 ? Math.min(Math.max(container.scrollTop / maxScrollTop, 0), 1) : 1
  emit('updateScrollState', {
    threadId: props.activeThreadId,
    state: {
      scrollTop: container.scrollTop,
      isAtBottom: atBottom,
      scrollRatio,
    },
  })
}

function enforceBottomState(): void {
  const container = conversationListRef.value
  if (!container) return
  userHasScrolledAwayFromBottom = false
  scrollToBottom()
  lastScrollTop = container.scrollTop
  emitScrollState(container)
}

function shouldLockToBottom(): boolean {
  return shouldFollowConversationBottom(userHasScrolledAwayFromBottom)
}

function runBottomLockFrame(): void {
  if (!shouldLockToBottom()) {
    cancelBottomLock()
    return
  }

  enforceBottomState()
  bottomLockFramesLeft -= 1
  if (bottomLockFramesLeft <= 0) {
    bottomLockFrame = 0
    return
  }
  bottomLockFrame = requestAnimationFrame(runBottomLockFrame)
}

function scheduleBottomLock(frames = 6): void {
  if (!shouldLockToBottom()) return
  if (bottomLockFrame) {
    cancelAnimationFrame(bottomLockFrame)
    bottomLockFrame = 0
  }
  bottomLockFramesLeft = Math.max(frames, 1)
  bottomLockFrame = requestAnimationFrame(runBottomLockFrame)
}

function onPendingImageSettled(): void {
  scheduleBottomLock(3)
}

function bindPendingImageHandlers(): void {
  if (!shouldLockToBottom()) return
  const container = conversationListRef.value
  if (!container) return

  const images = container.querySelectorAll<HTMLImageElement>('img.message-image-preview')
  for (const image of images) {
    if (image.complete || trackedPendingImages.has(image)) continue
    trackedPendingImages.add(image)
    image.addEventListener('load', onPendingImageSettled, { once: true })
    image.addEventListener('error', onPendingImageSettled, { once: true })
  }
}

async function scheduleThreadOpenScroll(): Promise<void> {
  await nextTick()
  if (scrollRestoreFrame) {
    cancelAnimationFrame(scrollRestoreFrame)
  }
  scrollRestoreFrame = requestAnimationFrame(() => {
    scrollRestoreFrame = 0
    enforceBottomState()
    const container = conversationListRef.value
    lastScrollTop = container?.scrollTop ?? 0
    userHasScrolledAwayFromBottom = false
    bindPendingImageHandlers()
    scheduleBottomLock()
  })
}

async function scheduleContentScrollUpdate(): Promise<void> {
  await nextTick()
  if (scrollRestoreFrame) {
    cancelAnimationFrame(scrollRestoreFrame)
  }
  scrollRestoreFrame = requestAnimationFrame(() => {
    scrollRestoreFrame = 0
    const container = conversationListRef.value
    if (!container) return

    if (shouldLockToBottom()) {
      bindPendingImageHandlers()
      scheduleBottomLock()
      return
    }

    emitScrollState(container)
  })
}

function requestEarlierMessages(): void {
  const container = conversationListRef.value
  if (
    !container ||
    !props.activeThreadId ||
    !props.hasEarlierMessages ||
    props.isLoadingEarlierMessages ||
    pendingPrependAnchor
  ) {
    return
  }

  pendingPrependAnchor = {
    threadId: props.activeThreadId,
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  }
  emit('loadEarlier')
}

async function restorePrependAnchor(): Promise<boolean> {
  const anchor = pendingPrependAnchor
  if (!anchor) return false
  await nextTick()

  const container = conversationListRef.value
  if (!container || anchor.threadId !== props.activeThreadId) {
    pendingPrependAnchor = null
    return false
  }

  const addedHeight = container.scrollHeight - anchor.scrollHeight
  if (addedHeight <= 0) return false

  container.scrollTop = anchor.scrollTop + addedHeight
  lastScrollTop = container.scrollTop
  userHasScrolledAwayFromBottom = true
  pendingPrependAnchor = null
  emitScrollState(container)
  bindPendingImageHandlers()
  scheduleResponseAnnotationMarkerUpdate()
  return true
}

async function maybeLoadHistoryToFillViewport(): Promise<void> {
  await nextTick()
  const container = conversationListRef.value
  if (
    !container ||
    props.isLoading ||
    props.isLoadingEarlierMessages ||
    !props.hasEarlierMessages ||
    pendingPrependAnchor
  ) {
    return
  }
  if (container.scrollHeight <= container.clientHeight + 1) {
    requestEarlierMessages()
  }
}

watch(
  () => props.messages,
  async (next) => {
    if (props.isLoading) return

    for (const m of next) {
      if (m.messageType !== 'commandExecution' || !m.commandExecution) continue
      const prev = prevCommandStatuses.value[m.id]
      const cur = m.commandExecution.status
      if (prev === 'inProgress' && cur !== 'inProgress') {
        scheduleCollapse(m.id)
      }
      prevCommandStatuses.value[m.id] = cur
    }

    if (await restorePrependAnchor()) return
    await scheduleContentScrollUpdate()
  },
)

watch(
  () => props.isLoadingEarlierMessages,
  async (loading) => {
    if (loading) return
    if (await restorePrependAnchor()) return
    pendingPrependAnchor = null
    await maybeLoadHistoryToFillViewport()
  },
)

watch(
  () => [props.hasEarlierMessages, props.activeThreadId, props.isLoading] as const,
  () => {
    void maybeLoadHistoryToFillViewport()
  },
  { flush: 'post' },
)

watch(
  responseTextAnnotations,
  (annotations) => {
    const activeIds = new Set(annotations.map((annotation) => annotation.id))
    for (const annotationId of responseAnnotationAnchors.keys()) {
      if (!activeIds.has(annotationId)) responseAnnotationAnchors.delete(annotationId)
    }
    if (editingResponseAnnotationId.value && !activeIds.has(editingResponseAnnotationId.value)) {
      closeResponseAnnotationEditor()
    }
    void nextTick(scheduleResponseAnnotationMarkerUpdate)
  },
  { deep: true },
)

watch(
  () => props.pendingRequests,
  async () => {
    if (props.isLoading) return
    await scheduleContentScrollUpdate()
  },
)

watch(
  () => props.automationProposals,
  async () => {
    if (props.isLoading) return
    await scheduleContentScrollUpdate()
  },
  { deep: true },
)

watch(
  () => props.liveOverlay,
  async () => {
    if (props.isLoading) return
    await scheduleContentScrollUpdate()
  },
  { deep: true },
)

watch(
  () => props.isLoading,
  async (loading) => {
    if (loading) {
      showScrollToBottom.value = false
      return
    }
    if (shouldForceThreadOpenToBottom(props.activeThreadId, loading)) {
      await scheduleThreadOpenScroll()
    }
  },
)

watch(
  () => props.activeThreadId,
  async () => {
    modalImageUrl.value = ''
    cancelResponseAnnotationRecording()
    responseAnnotationEditor.value = null
    editingResponseAnnotationId.value = null
    responseAnnotationDraft.value = ''
    dismissResponseSelection()
    hoveredResponseAnnotationId.value = null
    responseAnnotationAnchors.clear()
    responseAnnotationMarkers.value = []
    showScrollToBottom.value = false
    cancelBottomLock()
    lastScrollTop = 0
    userHasScrolledAwayFromBottom = false
    pendingPrependAnchor = null
    if (shouldForceThreadOpenToBottom(props.activeThreadId, props.isLoading)) {
      await scheduleThreadOpenScroll()
    }
  },
  { flush: 'post', immediate: true },
)

function onConversationScroll(): void {
  const container = conversationListRef.value
  if (!container || props.isLoading) return
  const nextScrollTop = container.scrollTop
  if (nextScrollTop < lastScrollTop - SCROLL_DIRECTION_THRESHOLD_PX) {
    userHasScrolledAwayFromBottom = true
    cancelBottomLock()
  }
  if (distanceFromBottom(container) <= BOTTOM_RESET_THRESHOLD_PX) {
    userHasScrolledAwayFromBottom = false
  }
  lastScrollTop = nextScrollTop
  emitScrollState(container)
  scheduleResponseAnnotationMarkerUpdate()
  if (nextScrollTop <= EARLIER_MESSAGES_THRESHOLD_PX) {
    requestEarlierMessages()
  }
}

function onScrollToBottomClick(): void {
  enforceBottomState()
  scheduleBottomLock(2)
}

function openImageModal(imageUrl: string): void {
  modalImageUrl.value = toRenderableImageUrl(imageUrl)
}

function closeImageModal(): void {
  modalImageUrl.value = ''
}

onMounted(() => {
  coarsePointerMediaQuery = window.matchMedia('(pointer: coarse)')
  syncCoarsePointerPreference()
  coarsePointerMediaQuery.addEventListener('change', syncCoarsePointerPreference)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('pointerup', onDocumentPointerUp)
  document.addEventListener('pointercancel', onDocumentPointerCancel)
  document.addEventListener('selectionchange', onDocumentSelectionChange)
  document.addEventListener('keydown', onDocumentKeyDown, true)
  window.addEventListener('resize', scheduleResponseAnnotationMarkerUpdate)
})

onBeforeUnmount(() => {
  coarsePointerMediaQuery?.removeEventListener('change', syncCoarsePointerPreference)
  coarsePointerMediaQuery = null
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('pointerup', onDocumentPointerUp)
  document.removeEventListener('pointercancel', onDocumentPointerCancel)
  document.removeEventListener('selectionchange', onDocumentSelectionChange)
  document.removeEventListener('keydown', onDocumentKeyDown, true)
  window.removeEventListener('resize', scheduleResponseAnnotationMarkerUpdate)
  cancelResponseAnnotationRecording()
  cancelScheduledResponseSelectionUpdate()
  if (scrollRestoreFrame) {
    cancelAnimationFrame(scrollRestoreFrame)
  }
  if (bottomLockFrame) {
    cancelAnimationFrame(bottomLockFrame)
  }
  if (responseAnnotationMarkerFrame) {
    cancelAnimationFrame(responseAnnotationMarkerFrame)
  }
})
</script>

<style scoped>
@reference "tailwindcss";

.conversation-root {
  @apply relative h-full min-h-0 p-0 flex flex-col overflow-y-hidden overflow-x-hidden bg-transparent border-none rounded-none;
  --conversation-readable-width: calc(44rem - 2.5rem);
  font-family: "Inter Variable", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  font-weight: 430;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

@media (max-width: 639px) {
  .conversation-root {
    --conversation-readable-width: 100%;
  }
}

.conversation-loading {
  @apply m-0 px-3 sm:px-5 text-sm text-zinc-400 text-center py-6 animate-pulse;
}

.conversation-empty {
  @apply m-0 px-3 sm:px-5 text-sm text-zinc-400 text-center py-6;
}

.conversation-list {
  @apply h-full min-h-0 list-none m-0 px-3 sm:px-5 py-0 overflow-y-auto overflow-x-hidden flex flex-col gap-4 sm:gap-5;
}

.conversation-history-control {
  @apply sticky top-0 z-10 mx-auto flex w-full justify-center pt-2;
  max-width: var(--conversation-readable-width);
}

.conversation-history-status {
  @apply h-8 rounded-full border px-3 text-xs shadow-sm backdrop-blur;
  @apply inline-flex items-center justify-center gap-2;
  border-color: color-mix(in srgb, var(--border) 82%, transparent);
  background: color-mix(in srgb, var(--surface-elevated) 92%, transparent);
  color: var(--text-secondary);
}

.conversation-history-spinner {
  @apply h-3.5 w-3.5 rounded-full border-2 animate-spin;
  border-color: color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
}

.conversation-item {
  @apply m-0 w-full flex;
}

.conversation-item-request {
  @apply justify-center;
}

.conversation-item-overlay {
  @apply justify-start;
}

.message-row {
  @apply relative w-full mx-auto flex;
  max-width: var(--conversation-readable-width);
}

.message-row[data-role='user'] {
  @apply justify-end;
}

.message-row[data-role='assistant'],
.message-row[data-role='system'] {
  @apply justify-start;
}

.conversation-bottom-anchor {
  @apply h-px;
}

.scroll-bottom-button {
  @apply absolute z-30 left-1/2 -translate-x-1/2 bottom-2 h-8 w-8 rounded-full border border-zinc-300 bg-white text-zinc-700 flex items-center justify-center shadow-sm transition-colors hover:bg-zinc-50 hover:text-zinc-900;
}

.scroll-bottom-button-icon {
  @apply h-4 w-4;
}

.scroll-bottom-button-enter-active,
.scroll-bottom-button-leave-active {
  transition: opacity 150ms ease-in-out;
}

.scroll-bottom-button-enter-from,
.scroll-bottom-button-leave-to {
  opacity: 0;
}

.message-stack {
  @apply flex flex-col w-full;
}

.request-card {
  @apply w-full rounded-xl border border-amber-300 bg-amber-50 px-3 sm:px-4 py-2 sm:py-3 flex flex-col gap-2;
  max-width: var(--conversation-readable-width);
}

.request-title {
  @apply m-0 text-sm leading-5 font-semibold text-amber-900;
}

.request-meta {
  @apply m-0 text-xs leading-4 text-amber-700;
}

.request-reason {
  @apply m-0 text-sm leading-5 text-amber-900 whitespace-pre-wrap;
}

.request-actions {
  @apply flex flex-wrap gap-1.5 sm:gap-2;
}

.request-button {
  @apply rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-900 hover:bg-amber-100 transition;
}

.request-button-primary {
  @apply border-amber-500 bg-amber-500 text-white hover:bg-amber-600;
}

.request-user-input {
  @apply flex flex-col gap-3;
}

.request-question {
  @apply flex flex-col gap-1;
}

.request-question-title {
  @apply m-0 text-sm leading-5 font-medium text-amber-900;
}

.request-question-text {
  @apply m-0 text-xs leading-4 text-amber-800;
}

.request-select {
  @apply h-8 rounded-md border border-amber-300 bg-white px-2 text-sm text-amber-900;
}

.request-input {
  @apply h-8 rounded-md border border-amber-300 bg-white px-2 text-sm text-amber-900 placeholder:text-amber-500;
}

.live-overlay-inline {
  @apply w-full px-0 py-0 flex flex-col gap-1;
  max-width: var(--conversation-readable-width);
}

.live-overlay-label {
  @apply m-0 text-sm leading-5 font-medium text-zinc-600 flex items-center gap-2;
}

/* --- Bouncing dots indicator --- */
.live-overlay-dots {
  @apply inline-flex items-center gap-1 shrink-0;
}

.live-overlay-dot {
  @apply inline-block w-1.5 h-1.5 rounded-full bg-emerald-500;
  animation: live-dot-bounce 1.4s ease-in-out infinite;
}

.live-overlay-dot:nth-child(1) { animation-delay: 0s; }
.live-overlay-dot:nth-child(2) { animation-delay: 0.16s; }
.live-overlay-dot:nth-child(3) { animation-delay: 0.32s; }

@keyframes live-dot-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* --- Shimmer sweep on label text --- */
.live-overlay-label-text {
  background: linear-gradient(
    90deg,
    theme('colors.zinc.600') 0%,
    theme('colors.zinc.600') 40%,
    theme('colors.zinc.400') 50%,
    theme('colors.zinc.600') 60%,
    theme('colors.zinc.600') 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: live-shimmer 2.4s ease-in-out infinite;
}

@keyframes live-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

.live-overlay-reasoning-details {
  @apply min-w-0 pl-4;
}

.live-overlay-reasoning-summary {
  @apply flex min-w-0 cursor-pointer items-baseline gap-2 text-sm leading-5 text-zinc-500;
}

.live-overlay-reasoning-title {
  @apply shrink-0 text-xs font-medium uppercase tracking-normal text-zinc-400;
}

.live-overlay-reasoning-preview {
  @apply min-w-0 truncate italic;
}

.live-overlay-reasoning {
  @apply mt-2 mb-0 text-sm leading-5 text-zinc-400 italic whitespace-pre-wrap;
}

.live-overlay-error {
  @apply m-0 text-sm leading-5 text-rose-600 whitespace-pre-wrap;
}

.message-body {
  @apply flex flex-col max-w-full;
  width: fit-content;
}

.message-body[data-role='assistant'],
.message-body[data-role='system'] {
  @apply w-full;
}

.message-body[data-role='user'] {
  @apply ml-auto items-end;
  align-self: flex-end;
  width: max-content;
  max-width: 100%;
}

.message-image-list {
  @apply list-none m-0 mb-2 p-0 flex flex-wrap gap-2;
}

.message-image-list[data-role='user'] {
  @apply ml-auto justify-end;
}

.message-image-item {
  @apply m-0;
}

.message-image-button {
  @apply block rounded-xl overflow-hidden border border-slate-300 bg-white p-0 transition hover:border-slate-400;
}

.message-image-preview {
  @apply block w-16 h-16 object-cover;
}

.message-file-attachments {
  @apply mb-2 flex flex-wrap gap-1.5;
}

.message-file-chip {
  @apply inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-600;
}

.message-file-chip-icon {
  @apply text-[10px] leading-none;
}

.message-file-chip-name {
  @apply truncate max-w-40 font-mono;
}

.message-response-annotations {
  @apply mb-2 w-fit max-w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.message-response-annotations-summary {
  @apply flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium;
}

.message-response-annotations-summary::-webkit-details-marker {
  display: none;
}

.message-response-annotations-icon {
  @apply h-3.5 w-3.5 shrink-0 text-zinc-500;
  color: var(--text-tertiary);
}

.message-response-annotations-list {
  @apply flex max-h-56 max-w-[min(28rem,80vw)] flex-col gap-2 overflow-y-auto border-t border-zinc-200 px-2.5 py-2;
  border-color: var(--border-soft);
}

.message-response-annotation {
  @apply m-0 border-l-2 border-zinc-300 pl-2 text-xs;
  border-color: var(--border-strong);
}

.message-response-annotation-quote {
  @apply m-0 line-clamp-3 whitespace-pre-wrap text-zinc-600;
  color: var(--text-secondary);
}

.message-response-annotation-comment {
  @apply mt-1 mb-0 font-medium whitespace-pre-wrap text-zinc-800;
  color: var(--text-primary);
}

:global(.response-selection-toolbar) {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  width: auto !important;
  min-width: 0 !important;
  gap: 0 !important;
  padding: 0.25rem !important;
  border: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--surface-elevated) 94%, transparent) !important;
  color: var(--text-primary) !important;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.16) !important;
  backdrop-filter: blur(10px);
}

:global(.response-selection-toolbar-button) {
  height: 1.875rem !important;
  gap: 0.375rem !important;
  padding-inline: 0.625rem !important;
  color: var(--text-primary) !important;
}

:global(.response-selection-toolbar-dismiss) {
  width: 1.875rem !important;
  height: 1.875rem !important;
  margin-left: 0.125rem;
  color: var(--text-secondary) !important;
}

:global(.response-selection-toolbar-dismiss:hover) {
  color: var(--text-primary) !important;
}

.response-selection-dock {
  position: absolute;
  z-index: 35;
  left: 50%;
  bottom: 0.625rem;
  display: flex;
  align-items: center;
  width: calc(100% - 1rem);
  max-width: 26rem;
  min-height: 3.25rem;
  gap: 0.375rem;
  padding: 0.25rem;
  border: 1px solid var(--border-soft);
  border-radius: 0.875rem;
  background: color-mix(in srgb, var(--surface-elevated) 95%, transparent);
  color: var(--text-primary);
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.2);
  backdrop-filter: blur(12px);
  transform: translateX(-50%);
}

.response-selection-dock-label {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.375rem;
  padding-left: 0.625rem;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 500;
  white-space: nowrap;
}

.response-selection-dock-label svg {
  width: 1rem;
  height: 1rem;
  flex: none;
}

.response-selection-dock-add,
.response-selection-dock-dismiss {
  min-height: 2.75rem !important;
  touch-action: manipulation;
}

.response-selection-dock-add {
  padding-inline: 0.875rem !important;
}

.response-selection-dock-dismiss {
  width: 2.75rem !important;
  color: var(--text-secondary) !important;
}

.response-selection-dock-enter-active,
.response-selection-dock-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.response-selection-dock-enter-from,
.response-selection-dock-leave-to {
  opacity: 0;
  transform: translate(-50%, 0.375rem);
}

:global(.response-annotation-popover) {
  width: min(22rem, calc(100vw - 1rem)) !important;
  padding: 0.75rem !important;
  border: 1px solid var(--border-soft);
  background: var(--surface-elevated) !important;
  color: var(--text-primary) !important;
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.2) !important;
}

:global(.response-annotation-popover--compact) {
  width: min(26rem, calc(100vw - 1rem)) !important;
  max-height: calc(100dvh - 1rem) !important;
  padding: 0.75rem !important;
}

:global(.response-annotation-popover--compact .response-annotation-input) {
  min-height: 4.5rem !important;
  font-size: 1rem !important;
  resize: none;
}

:global(.response-annotation-popover--compact .response-annotation-actions button) {
  min-height: 2.75rem;
}

:global(.response-annotation-popover--compact .response-annotation-mic) {
  width: 2.75rem;
}

:global(.response-annotation-form) {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

:global(.response-annotation-heading) {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 600;
}

:global(.response-annotation-quote) {
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

:global(.response-annotation-input) {
  min-height: 5rem !important;
  resize: vertical;
  border-color: var(--border-strong) !important;
  background: var(--content-bg) !important;
  color: var(--text-primary) !important;
  font-size: 0.875rem !important;
}

:global(.response-annotation-actions) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.375rem;
}

:global(.response-annotation-actions-leading),
:global(.response-annotation-actions-trailing) {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

:global(.response-annotation-actions-leading) {
  min-width: 0;
}

:global(.response-annotation-actions-trailing) {
  margin-left: auto;
}

:global(.response-annotation-delete) {
  color: #dc2626 !important;
}

:global(.response-annotation-delete:hover) {
  background: color-mix(in srgb, #ef4444 10%, transparent) !important;
  color: #b91c1c !important;
}

:global(.response-annotation-mic) {
  color: var(--text-secondary) !important;
}

:global(.response-annotation-mic:hover) {
  color: var(--text-primary) !important;
}

:global(.response-annotation-mic.is-recording) {
  background: color-mix(in srgb, #ef4444 14%, transparent) !important;
  color: #dc2626 !important;
}

:global(.response-annotation-mic-icon) {
  width: 1rem;
  height: 1rem;
}

:global(.response-annotation-mic-spinner) {
  width: 0.875rem;
  height: 0.875rem;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 9999px;
  animation: response-annotation-spin 700ms linear infinite;
}

@keyframes response-annotation-spin {
  to {
    transform: rotate(360deg);
  }
}

:global(.response-annotation-marker-layer) {
  position: fixed;
  inset: 0;
  z-index: 40;
  pointer-events: none;
}

:global(.response-annotation-marker) {
  position: absolute;
  width: 25px;
  height: 25px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #0285ff;
  cursor: pointer;
  pointer-events: auto;
  transform: translate(-50%, -50%);
  transition: transform 120ms ease;
}

:global(.response-annotation-marker.is-selected) {
  transform: translate(-50%, -50%) scale(1.08);
}

:global(.response-annotation-marker:focus-visible) {
  border-radius: 9999px;
  outline: 2px solid var(--focus-ring, #60a5fa);
  outline-offset: 2px;
}

:global(.response-annotation-marker-shape) {
  position: absolute;
  inset: 0;
  width: 26px;
  height: 25px;
}

:global(.response-annotation-marker-label) {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: white;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  transform: translate(-0.5px, -0.5px);
}

:global(.response-annotation-marker-preview) {
  position: absolute;
  z-index: 1;
  max-width: min(294px, calc(100vw - 32px));
  height: 32px;
  overflow: hidden;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-soft);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--surface-elevated) 92%, transparent);
  color: var(--text-primary);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.18);
  font-size: 0.875rem;
  line-height: 1.25rem;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(8px);
}

.message-card {
  @apply w-full max-w-full px-0 py-0 bg-transparent border-none rounded-none;
}

.message-text-flow {
  @apply flex flex-col gap-2;
}

.message-text {
  @apply m-0 text-sm leading-relaxed whitespace-pre-wrap text-slate-800;
}

.message-markdown-content {
  @apply break-words;
  overflow-wrap: anywhere;
}

.message-markdown-content :deep(*) {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.message-markdown-content :deep(:first-child) {
  margin-top: 0;
}

.message-markdown-content :deep(:last-child) {
  margin-bottom: 0;
}

.message-tool-summary {
  @apply m-0 text-sm leading-relaxed text-zinc-600 flex items-center gap-2;
}

.message-tool-summary::before {
  content: '';
  @apply inline-block h-1.5 w-1.5 rounded-full bg-zinc-400 shrink-0;
}

.message-tool-summary--active {
  @apply text-zinc-700;
}

.message-tool-summary--active::before {
  @apply bg-emerald-500;
  animation: live-dot-bounce 1.4s ease-in-out infinite;
}

.tool-call-row {
  @apply grid min-w-0 items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs;
  grid-template-columns: auto minmax(0, auto) minmax(0, 1fr) auto;
  border-color: var(--border-soft);
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.tool-call-dot {
  @apply h-1.5 w-1.5 shrink-0 rounded-full;
  background: var(--text-tertiary);
}

.tool-call-row--active .tool-call-dot {
  @apply bg-emerald-500;
  animation: live-dot-bounce 1.4s ease-in-out infinite;
}

.tool-call-row--failed {
  border-color: color-mix(in srgb, var(--destructive) 28%, var(--border-soft));
  background: color-mix(in srgb, var(--destructive) 8%, var(--surface-muted));
  color: var(--destructive);
}

.tool-call-row--failed .tool-call-dot {
  background: var(--destructive);
}

.tool-call-label {
  @apply min-w-0 truncate font-medium;
  color: var(--text-primary);
}

.tool-call-meta {
  @apply flex min-w-0 items-center overflow-hidden;
  grid-column: 3;
}

.tool-call-detail {
  @apply min-w-0 truncate;
  color: var(--text-tertiary);
}

.tool-call-detail::before,
.tool-call-progress::before {
  content: '\00b7';
  @apply mr-2;
  color: var(--border-strong);
}

.tool-call-progress {
  @apply min-w-0 truncate;
  color: var(--text-tertiary);
}

.tool-call-status {
  @apply shrink-0 text-[11px] font-medium uppercase tracking-normal;
  grid-column: 4;
  color: var(--text-tertiary);
}

.tool-call-row--active .tool-call-status {
  @apply text-emerald-600;
}

.tool-call-row--failed .tool-call-status {
  color: var(--destructive);
}

.tool-call-row--warning {
  border-color: color-mix(in srgb, #d97706 30%, var(--border-soft));
  background: color-mix(in srgb, #d97706 8%, var(--surface-muted));
  color: var(--text-secondary);
}

.tool-call-row--warning .tool-call-dot {
  background: #d97706;
}

.tool-call-row--warning .tool-call-status {
  color: #b45309;
}

:global(html[data-theme='dark']) .tool-call-row--warning .tool-call-dot {
  background: #fbbf24;
}

:global(html[data-theme='dark']) .tool-call-row--warning .tool-call-status {
  color: #fbbf24;
}

.tool-call-description {
  @apply col-start-2 col-end-5 m-0 whitespace-normal leading-relaxed;
  color: var(--text-secondary);
}

.message-markdown-content :deep(pre) {
  @apply max-w-full rounded-lg bg-zinc-900 text-zinc-200 px-3.5 py-3 text-xs font-mono overflow-x-auto my-4 sm:my-3 sm:px-4;
  overflow-wrap: normal;
  word-break: normal;
  -webkit-overflow-scrolling: touch;
}

.message-markdown-content :deep(code) {
  @apply rounded-md border border-slate-200 bg-slate-100/60 px-1.5 py-0.5 text-[0.875em] leading-[1.4] text-slate-900 font-mono;
}

.message-markdown-content :deep(code)::before {
  content: '' !important;
}

.message-markdown-content :deep(code)::after {
  content: '' !important;
}

.message-markdown-content :deep(pre code) {
  @apply border-none bg-transparent p-0 text-inherit rounded-none;
  white-space: pre;
}

.message-markdown-content :deep(table) {
  @apply my-5 block max-w-full overflow-x-auto border-separate border-spacing-0 text-left text-sm sm:my-4;
  color: var(--text-secondary);
  scrollbar-width: thin;
  -webkit-overflow-scrolling: touch;
}

.message-markdown-content :deep(th),
.message-markdown-content :deep(td) {
  @apply border-b px-0 py-2 pr-5 align-top;
  border-color: var(--border-soft);
  min-width: 8rem;
  max-width: 20rem;
  overflow-wrap: anywhere;
}

.message-markdown-content :deep(th) {
  @apply font-semibold;
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.message-markdown-content :deep(td) {
  color: var(--text-secondary);
}

.message-markdown-content :deep(th:last-child),
.message-markdown-content :deep(td:last-child) {
  padding-right: 0;
}

.message-markdown-content :deep(img) {
  @apply w-auto h-auto max-w-full sm:max-w-[min(560px,85vw)] max-h-[min(460px,62vh)] object-contain bg-white rounded-xl border border-slate-300;
}

.message-raw-details {
  @apply mt-3 border-t border-slate-200/70 pt-3;
}

.message-raw-summary {
  @apply cursor-pointer text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500;
}

.message-raw-payload {
  @apply mt-3 overflow-x-auto rounded-xl bg-slate-100/80 px-3 py-3 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap break-words;
}

.message-stack[data-role='user'] {
  @apply items-end;
}

.message-stack[data-role='assistant'],
.message-stack[data-role='system'] {
  @apply items-start;
}

.message-card[data-role='user'] {
  @apply w-fit rounded-2xl bg-slate-200 px-3 sm:px-4 py-2 sm:py-3 max-w-[92%] sm:max-w-[min(35rem,100%)];
  width: max-content;
  margin-left: auto;
  align-self: flex-end;
}

.message-delivery-status {
  @apply mt-1 mb-0 inline-flex items-center gap-1.5 pr-1 text-[11px] leading-4 text-zinc-500;
}

.message-delivery-dot {
  @apply h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400;
}

.message-delivery-status[data-state='pending'] .message-delivery-dot {
  animation: live-dot-bounce 1.4s ease-in-out infinite;
}

.message-delivery-status[data-state='sent'] {
  @apply text-emerald-600;
}

.message-delivery-status[data-state='sent'] .message-delivery-dot {
  @apply bg-emerald-500;
}

.message-delivery-status[data-state='failed'] {
  @apply text-rose-600;
}

.message-delivery-status[data-state='failed'] .message-delivery-dot {
  @apply bg-rose-500;
}

.message-card[data-role='assistant'],
.message-card[data-role='system'] {
  @apply px-0 py-0 bg-transparent border-none rounded-none;
}

.conversation-item[data-message-type='worked'] .message-stack,
.conversation-item[data-message-type='worked'] .message-body,
.conversation-item[data-message-type='worked'] .message-card,
.conversation-item[data-message-type='commandExecution'] .message-stack,
.conversation-item[data-message-type='commandExecution'] .message-body,
.conversation-item[data-message-type='commandExecution'] .message-card {
  @apply w-full max-w-full;
}

.worked-separator-wrap {
  @apply w-full flex flex-col gap-0;
}

.worked-separator {
  @apply w-full flex items-center gap-3 bg-transparent border-none p-0;
}

.worked-separator-line {
  @apply h-px bg-zinc-300/80 flex-1;
}

.worked-separator-text {
  @apply m-0 text-sm leading-relaxed font-normal text-slate-800;
}

.command-card {
  @apply w-full;
}

.image-modal-backdrop {
  @apply fixed inset-0 z-50 bg-black/40 p-2 sm:p-6 flex items-center justify-center;
}

.image-modal-content {
  @apply relative max-w-[min(92vw,1100px)] max-h-[92vh];
}

.image-modal-close {
  @apply absolute top-2 right-2 z-10 w-10 h-10 rounded-full bg-white/90 text-slate-900 border border-slate-300 flex items-center justify-center;
}

.image-modal-image {
  @apply block max-w-full max-h-[90vh] rounded-2xl shadow-2xl bg-white;
}

.icon-svg {
  @apply w-5 h-5;
}

.message-actions {
  @apply mt-1 flex items-center gap-0.5 self-start opacity-0 transition-opacity;
}

.conversation-item-actionable:hover .message-actions,
.conversation-item-actionable:focus-within .message-actions {
  @apply opacity-100;
}

.message-action-button {
  color: var(--text-tertiary) !important;
}

.message-action-button:hover {
  background: var(--surface-hover) !important;
  color: var(--text-primary) !important;
}

.message-action-icon {
  @apply h-3.5 w-3.5;
}

.continue-chat-dialog-overlay {
  @apply fixed inset-0 z-[80];
  background: var(--overlay);
}

.continue-chat-dialog {
  @apply fixed left-1/2 top-1/2 z-[81] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-4 shadow-2xl outline-none sm:p-5;
  border-color: var(--border-soft);
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.continue-chat-dialog-header {
  @apply flex flex-col gap-1;
}

.continue-chat-dialog-title {
  @apply text-base font-semibold leading-6;
  color: var(--text-primary);
}

.continue-chat-dialog-description {
  @apply text-sm leading-5;
  color: var(--text-tertiary);
}

.continue-chat-options {
  @apply mt-4 flex flex-col gap-1;
}

.continue-chat-option {
  @apply h-auto w-full justify-start gap-3 whitespace-normal rounded-xl px-3 py-2.5 text-left;
  color: var(--text-primary) !important;
}

.continue-chat-option:hover,
.continue-chat-option:focus-visible {
  background: var(--surface-hover) !important;
}

.continue-chat-option-icon {
  @apply h-4 w-4 shrink-0;
  color: var(--text-tertiary);
}

.continue-chat-option-copy {
  @apply flex min-w-0 flex-1 flex-col gap-0.5;
}

.continue-chat-option-label {
  @apply text-sm font-medium leading-5;
  color: var(--text-primary);
}

.continue-chat-option-description {
  @apply text-xs font-normal leading-4;
  color: var(--text-tertiary);
}

@media (hover: none) {
  .message-actions {
    @apply opacity-100;
  }
}

.cmd-row {
  @apply w-full flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-200 bg-zinc-50 cursor-pointer transition text-left hover:bg-zinc-100;
}

.cmd-row.cmd-expanded {
  @apply rounded-b-none border-b-0;
}

.cmd-chevron {
  @apply text-[10px] text-zinc-400 transition-transform duration-150 flex-shrink-0;
}

.cmd-chevron-open {
  transform: rotate(90deg);
}

.cmd-label {
  @apply flex-1 min-w-0 truncate text-xs font-mono text-zinc-700;
}

.cmd-status {
  @apply text-[11px] font-medium flex-shrink-0 ml-auto;
}

.cmd-status-running .cmd-status {
  @apply text-amber-600 animate-pulse;
}

.cmd-status-ok .cmd-status {
  @apply text-emerald-600;
}

.cmd-status-error .cmd-status {
  @apply text-rose-600;
}

.cmd-output-wrap {
  @apply rounded-b-lg bg-zinc-900;
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 300ms ease-out, border-color 300ms ease-out;
  border: 1px solid transparent;
  border-top: none;
}

.cmd-output-wrap.cmd-output-visible {
  grid-template-rows: 1fr;
  border-color: #e4e4e7;
}

.cmd-output-wrap.cmd-output-collapsing {
  grid-template-rows: 1fr;
  border-color: #e4e4e7;
}

.cmd-output-inner {
  overflow: hidden;
  min-height: 0;
}

.cmd-output {
  @apply m-0 px-3 py-2 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words max-h-60 overflow-y-auto;
}
</style>
