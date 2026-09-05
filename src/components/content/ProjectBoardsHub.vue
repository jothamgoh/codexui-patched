<template>
  <div class="boards-hub" data-testid="project-board">
    <header class="boards-header">
      <div class="boards-heading-copy">
        <h2>Project board</h2>
        <p>Plan the work, choose your agents, and follow each feature to completion.</p>
      </div>
      <div class="boards-header-actions">
        <Button v-if="activeBoard" type="button" variant="outline" :disabled="boardPlanningActive || isMutating" @click="$emit('plan-board', activeBoard.id)"><Sparkles aria-hidden="true" /> Plan features</Button>
        <Button type="button" variant="outline" @click="agentDialogOpen = true">
          <Users aria-hidden="true" /> Agents
        </Button>
        <Button type="button" variant="outline" :disabled="!selectedProjectPath" @click="openBoardEditor">
          <Plus aria-hidden="true" /> New board
        </Button>
        <Button type="button" :disabled="!activeBoard" @click="openFeatureEditor()">
          <Plus aria-hidden="true" /> New feature
        </Button>
      </div>
    </header>

    <div class="boards-toolbar">
      <label>
        <span>Project</span>
        <select v-model="selectedProjectPath" data-testid="board-project-select">
          <option v-for="project in projectOptions" :key="project.path" :value="project.path">
            {{ project.name }}
          </option>
        </select>
      </label>
      <label v-if="projectBoards.length > 0">
        <span>Board</span>
        <select :value="activeBoard?.id ?? ''" data-testid="board-select" @change="selectBoardFromEvent">
          <option v-for="board in projectBoards" :key="board.id" :value="board.id">
            {{ board.name }}{{ board.isDefault ? ' · default' : '' }}
          </option>
        </select>
      </label>
      <label v-if="activeBoard" class="boards-auto-toggle">
        <input
          type="checkbox"
          :checked="activeBoard.autoDispatch"
          :disabled="isDictating || isMutating"
          @change="toggleAutoDispatch"
        />
        <span class="boards-live-dot" aria-hidden="true" />
        Continue within features
        <small>{{ boardAgents.length }} agents</small>
      </label>
    </div>

    <section v-if="activeBoard" class="board-workflow" aria-label="Project delivery">
      <div class="workflow-state">
        <strong>{{ boardPlanningActive ? 'Planning your features…' : activeQueue?.status === 'running' ? 'Delivery is running' : activeQueue?.status === 'paused' ? 'Delivery paused' : 'Ready when you are' }}</strong>
        <p>{{ activeQueue?.reason || (boardPlanningActive ? 'Your coordinator is reading the plan and preparing cards. No implementation yet.' : 'Plan the project, review its features, then run one feature or a selected queue.') }}</p>
      </div>
      <div class="boards-header-actions">
        <Button v-if="activeBoard.sourceThreadId" type="button" size="sm" variant="ghost" @click="$emit('select-thread', activeBoard.sourceThreadId)">Planning chat</Button>
        <Button v-if="activeBoard.planningThreadId" type="button" size="sm" variant="ghost" @click="$emit('select-thread', activeBoard.planningThreadId)">Coordinator chat</Button>
        <Button v-if="activeQueue?.status === 'running'" type="button" size="sm" variant="outline" :disabled="isDictating || isMutating" @click="pauseQueue">Pause delivery</Button>
        <Button v-else type="button" size="sm" :disabled="queueCandidates.length === 0 || boardPlanningActive || isMutating" @click="openQueue">{{ activeQueue ? 'Resume selected features' : 'Run selected features' }}</Button>
      </div>
      <details v-if="activeBoard.plan" class="board-plan-summary"><summary>Project plan</summary><p>{{ activeBoard.plan }}</p></details>
      <p v-if="latestBoardPlanRun?.status === 'failed' || latestBoardPlanRun?.status === 'interrupted'" class="boards-alert" role="alert">{{ latestBoardPlanRun.error || 'Planning stopped. Open the coordinator chat or plan again.' }}</p>
    </section>

    <div v-if="activeBoard && featureCards.length" class="board-overview" aria-label="Board overview">
      <div class="board-score">
        <span><span class="lane-status-dot" data-tone="blue" />{{ workingFeatureCount }} in progress</span>
        <button type="button" @click="activeView = 'needs-you'"><span class="lane-status-dot" data-tone="amber" />{{ attentionCount }} need you</button>
        <span><span class="lane-status-dot" data-tone="green" />{{ completedFeatureCount }} done</span>
      </div>
      <DictationField v-if="activeView === 'board'" v-model="featureSearch" label="Find a feature" v-bind="voiceField('feature-search')" aria-label="Find a feature" placeholder="Find a feature…" class="feature-search" />
    </div>

    <div v-if="activeBoard" class="board-view-tabs" role="tablist" aria-label="Board views">
      <button v-for="view in boardViews" :id="`board-tab-${view.id}`" :key="view.id" type="button" role="tab"
        :aria-selected="activeView === view.id" :tabindex="activeView === view.id ? 0 : -1" :data-board-view="view.id"
        aria-controls="board-view-panel" @click="activeView = view.id" @keydown="navigateBoardView($event, view.id)">
        {{ view.label }}<span v-if="view.id === 'needs-you' && attentionCount">{{ attentionCount }}</span>
      </button>
    </div>

    <p v-if="error" class="boards-alert" role="alert">{{ error }}</p>
    <div v-if="isLoading && snapshot.boards.length === 0" class="boards-empty">Loading project boards…</div>
    <div v-else-if="projectOptions.length === 0" class="boards-empty">
      <FolderKanban aria-hidden="true" />
      <strong>Open a project first</strong>
      <span>Project boards belong to a folder, so Codex knows where agents should work.</span>
    </div>
    <div v-else-if="!activeBoard" class="boards-empty">
      <FolderKanban aria-hidden="true" />
      <strong>No board for this project</strong>
      <span>Create the default board to start tracking features.</span>
      <Button type="button" @click="ensureSelectedProjectBoard">Create project board</Button>
    </div>

    <section v-else id="board-view-panel" class="board-view-panel" role="tabpanel" :aria-labelledby="`board-tab-${activeView}`" tabindex="0">
      <template v-if="activeView === 'board'">
      <div v-if="featureCards.length === 0" class="boards-empty boards-empty-compact">
        <Sparkles aria-hidden="true" />
        <strong>Turn a large build into visible work</strong>
        <span>Create a feature. Its Lead chat will plan tasks, hand them to specialists, and keep this board updated.</span>
        <Button type="button" @click="openFeatureEditor()">Create first feature</Button>
      </div>

      <div v-else class="boards-lanes" aria-label="Feature board">
        <section
          v-for="column in columns"
          :key="column.key"
          class="board-lane"
          :data-board-status="column.key"
          @dragover.prevent
          @drop="dropOnColumn(column.moveStatus)"
        >
          <header>
            <span class="lane-status-dot" :data-tone="column.tone" />
            <h3>{{ column.label }}</h3>
            <span>{{ cardsForColumn(column.statuses).length }}</span>
          </header>
          <p class="lane-hint">{{ column.hint }}</p>

          <div class="board-lane-list">
            <article
              v-for="card in cardsForColumn(column.statuses)"
              :key="card.id"
              class="board-card"
              :class="{ 'is-selected': selectedCard?.id === card.id }"
              :data-feature-id="card.id"
              :draggable="!cardIsLocked(card) && !isMutating"
              @dragstart="draggedCardId = card.id"
              @dragend="draggedCardId = ''"
            >
              <button type="button" class="board-card-main" @click="selectCard(card)">
                <div class="board-card-kicker">
                  <span>{{ card.type === 'qa_batch' ? 'QA batch' : priorityLabel(card.priority) }}</span>
                  <span v-if="openQuestionFor(card) || requestForCard(card)" class="needs-you-pill">{{ requestForCard(card) ? nativeRequestLabel(card) : 'Needs you' }}</span>
                </div>
                <strong>{{ card.title }}</strong>
                <p v-if="card.progressNote || card.description">{{ card.progressNote || card.description }}</p>
                <p v-if="dependencyLabel(card)" class="dependency-note">{{ dependencyLabel(card) }}</p>
                <div class="board-card-meta">
                  <span><ListChecks aria-hidden="true" /> {{ taskProgress(card) }}</span>
                  <span v-if="agentFor(card.assignedAgentId)">
                    <span class="agent-avatar" aria-hidden="true">{{ agentFor(card.assignedAgentId)?.name.slice(0, 1).toUpperCase() }}</span> {{ agentFor(card.assignedAgentId)?.name }}
                  </span>
                </div>
              </button>
              <label class="board-card-move" @click.stop>
                <span class="sr-only">Move {{ card.title }}</span>
                <select :value="cardDisplayStatus(card)" :aria-label="`Move ${card.title}`" :disabled="cardIsLocked(card) || isMutating" @change="moveCardFromEvent(card, $event)">
                  <option v-for="status in moveStatuses" :key="status.value" :value="status.value" :disabled="status.value === 'needs_input'">{{ status.label }}</option>
                </select>
                <ChevronDown aria-hidden="true" />
              </label>
            </article>
            <button class="lane-add" type="button" @click="openFeatureEditor()">
              <Plus aria-hidden="true" /> Add feature
            </button>
          </div>
        </section>
      </div>
      </template>
      <BoardDailyViews v-else :key="activeView" :view="activeView" :board-id="activeBoard.id" :snapshot="snapshot"
        :questions="openBoardQuestions" :attention-cards="attentionCards" :pending-requests="pendingRequests"
        @open-feature="(card, questionId) => emit('select-feature', card.id, card.boardId, questionId)"
        @open-thread="threadId => emit('select-thread', threadId)" />
    </section>

    <DialogRoot :open="Boolean(selectedCard)" :modal="!isDockedDetail" @update:open="!$event && closeCard()">
      <DialogPortal>
        <DialogOverlay class="board-panel-backdrop" />
        <DialogContent v-if="selectedCard" class="board-detail-panel" :aria-modal="isDockedDetail ? undefined : true" :aria-describedby="undefined" data-testid="feature-detail"
          @interact-outside="keepDockedDetailOpen" @open-auto-focus="rememberFocus('detail')" @close-auto-focus="restoreFocus('detail', $event)">
          <header class="board-detail-header">
            <div>
              <span>{{ selectedCard.type === 'qa_batch' ? 'QA batch' : requestForCard(selectedCard) ? nativeRequestLabel(selectedCard) : statusLabel(selectedCard.status) }}</span>
              <DialogTitle>{{ selectedCard.title }}</DialogTitle>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close feature" @click="closeCard">
              <X aria-hidden="true" />
            </Button>
          </header>

          <div class="board-detail-body">
            <p v-if="error" class="boards-alert" role="alert">{{ error }}</p>
            <div class="board-detail-actions">
              <Button
                v-if="canStartSelectedCard"
                type="button"
                :disabled="selectedRunIsActive || Boolean(selectedOpenQuestion) || isMutating"
                data-testid="start-feature"
                @click="startSelectedCard"
              >
                <Play aria-hidden="true" /> {{ selectedCard.planStatus === 'ready' && !selectedTasks.some(task => task.status === 'done') ? 'Start work' : selectedCard.threadId ? 'Continue' : 'Plan & start' }}
              </Button>
              <Button v-if="canStartSelectedCard && !selectedTasks.some(task => task.status === 'working' || task.status === 'done')" type="button" variant="outline" :disabled="selectedRunIsActive || Boolean(selectedOpenQuestion) || isMutating" @click="planSelectedFeature"><Sparkles aria-hidden="true" />{{ selectedCard.planStatus === 'ready' ? 'Revise plan' : 'Plan first' }}</Button>
              <Button v-if="selectedRunIsActive" type="button" variant="outline" :disabled="isMutating" @click="stopSelectedFeature"><LoaderCircle v-if="stoppingFeatureId === selectedCard.id" class="animate-spin" aria-hidden="true" /><Square v-else aria-hidden="true" />{{ stoppingFeatureId === selectedCard.id ? 'Stopping…' : 'Stop run' }}</Button>
              <Button v-if="selectedCard.threadId" type="button" variant="outline" @click="$emit('select-thread', selectedCard.threadId)">
                <MessageSquare aria-hidden="true" /> Open Lead chat
              </Button>
              <Button v-if="selectedCard.sourceThreadId" type="button" variant="ghost" @click="$emit('select-thread', selectedCard.sourceThreadId)">Original chat</Button>
              <Button type="button" variant="outline" :disabled="selectedRunIsActive" @click="openEditSelectedCard">
                <Pencil aria-hidden="true" /> Edit
              </Button>
              <label class="detail-status-select">
                <span>Status</span>
                <select :value="selectedCard.status" :disabled="cardIsLocked(selectedCard) || isMutating" @change="moveCardFromEvent(selectedCard, $event)">
                  <option v-for="status in moveStatuses" :key="status.value" :value="status.value" :disabled="status.value === 'needs_input'">{{ status.label }}</option>
                </select>
              </label>
            </div>

            <section v-if="requestForCard(selectedCard)" class="needs-you-card" aria-label="Lead request"><strong>{{ nativeRequestLabel(selectedCard) }}</strong><p>The Lead is waiting for you. Open its chat to review the request, or stop this run.</p><Button type="button" variant="outline" @click="$emit('select-thread', selectedCard.threadId)">Review in Lead chat</Button></section>
            <p v-if="!selectedRunIsActive && selectedRuns[0]?.error" class="detail-muted" role="status">{{ selectedRuns[0].error }}</p>
            <p v-if="dependencyLabel(selectedCard)" class="dependency-note">{{ dependencyLabel(selectedCard) }}</p>
            <section v-if="selectedCard.planSummary" class="detail-section"><h3>{{ selectedCard.planStatus === 'ready' ? 'Plan ready' : 'Plan' }}</h3><p class="detail-prewrap">{{ selectedCard.planSummary }}</p><p v-if="selectedCard.planStatus === 'ready'" class="detail-muted">Review the tasks below. Start work when you are ready, or revise the brief and plan again.</p></section>
            <p class="detail-muted">Lead settings: {{ selectedCard.model || agentFor(selectedCard.assignedAgentId)?.model || 'App default model' }} · {{ selectedCard.reasoningEffort || agentFor(selectedCard.assignedAgentId)?.reasoningEffort || 'Default' }} reasoning.</p>

            <p v-if="selectedCard.type === 'qa_batch'" class="detail-muted">QA batch cards track later verification. Automated batch runs are not available yet.</p>
            <p v-if="cardIsLocked(selectedCard)" class="detail-muted">Status is controlled by the active run or open questions.</p>

            <section v-if="selectedOpenQuestion" class="needs-you-card" data-testid="needs-you-question">
              <div class="needs-you-heading"><CircleHelp aria-hidden="true" /><strong>Needs your answer</strong></div>
              <label v-if="selectedQuestions.length > 1" class="question-picker"><span>Open question</span><select :value="selectedOpenQuestion.id" @change="selectQuestion"><option v-for="question in selectedQuestions" :key="question.id" :value="question.id">{{ question.prompt }}</option></select></label>
              <p>{{ selectedOpenQuestion.prompt }}</p>
              <form @submit.prevent="answerSelectedQuestion">
                <DictationField :key="selectedOpenQuestion.id" v-model="questionAnswer" label="Your answer" v-bind="voiceField('question')" multiline required rows="3" placeholder="Give the Lead the decision it needs" />
                <Button type="submit" size="sm" :disabled="isDictating || isMutating || !questionAnswer.trim()">Answer & continue</Button>
              </form>
            </section>

            <section v-if="selectedCard.description" class="detail-section">
              <h3>Brief</h3>
              <p class="detail-prewrap">{{ selectedCard.description }}</p>
            </section>
            <section v-if="selectedCard.acceptanceCriteria" class="detail-section">
              <h3>Done when</h3>
              <p class="detail-prewrap">{{ selectedCard.acceptanceCriteria }}</p>
            </section>

            <section class="detail-section">
              <div class="detail-section-title">
                <h3>Tasks</h3>
                <span>{{ selectedTasks.filter((task) => task.status === 'done').length }}/{{ selectedTasks.length }}</span>
              </div>
              <div v-if="selectedTasks.length === 0" class="detail-muted">The Lead will create the task plan when this feature starts.</div>
              <ol v-else class="task-list">
                <li v-for="task in selectedTasks" :key="task.id" :data-task-status="task.status">
                  <span class="task-status-icon">
                    <Check v-if="task.status === 'done'" aria-hidden="true" />
                    <LoaderCircle v-else-if="task.status === 'working'" aria-hidden="true" />
                    <CircleHelp v-else-if="task.status === 'needs_input'" aria-hidden="true" />
                    <span v-else />
                  </span>
                  <div>
                    <strong>{{ task.title }}</strong>
                    <p>{{ task.summary || task.progressNote || task.description }}</p>
                    <small>{{ agentFor(task.assignedAgentId)?.name ?? 'Unassigned' }} · {{ task.taskPurpose === 'verification' ? 'Verification · ' : '' }}{{ statusLabel(task.status) }}</small>
                  </div>
                </li>
              </ol>
            </section>

            <section v-if="selectedArtifacts.length > 0" class="detail-section">
              <h3>Artifacts</h3>
              <ul class="artifact-list">
                <li v-for="artifact in selectedArtifacts" :key="artifact.id">
                  <FileText aria-hidden="true" /><span><strong>{{ artifact.label }}</strong><code>{{ artifact.path }}</code></span>
                </li>
              </ul>
            </section>

            <section class="detail-section">
              <div class="detail-section-title"><h3>Activity</h3><span>{{ selectedRuns.length }} runs</span></div>
              <div v-if="selectedRuns.length === 0" class="detail-muted">No agent runs yet.</div>
              <ul v-else class="run-list">
                <li v-for="run in selectedRuns" :key="run.id">
                  <span class="run-dot" :data-status="run.status" />
                  <div><strong>{{ agentFor(run.agentId)?.name ?? 'Agent' }} · {{ runStatusLabel(run.status) }}</strong><p>{{ run.error || run.summary || formatTime(run.startedAtIso) }}</p><small v-if="run.requestedModel !== undefined || run.requestedReasoningEffort">Requested: {{ run.requestedModel || 'App default model' }}<template v-if="run.requestedReasoningEffort"> · {{ run.requestedReasoningEffort }} reasoning</template></small></div>
                </li>
              </ul>
            </section>

            <section class="detail-section">
              <h3>Comments</h3>
              <ul v-if="selectedComments.length > 0" class="comment-list">
                <li v-for="comment in selectedComments" :key="comment.id"><strong>{{ comment.author }}</strong><p>{{ comment.text }}</p></li>
              </ul>
              <form class="comment-form" @submit.prevent="addSelectedComment">
                <DictationField :key="selectedCard.id" v-model="commentText" label="Comment" v-bind="voiceField('comment')" placeholder="Add context for the Lead" />
                <Button type="submit" size="sm" variant="outline" :disabled="isDictating || isMutating || !commentText.trim()">Add</Button>
              </form>
            </section>
          </div>

          <footer class="board-detail-footer">
            <Button type="button" variant="ghost" class="danger-button" :disabled="selectedRunIsActive || isMutating" @click="deleteSelectedCard">
              <Trash2 aria-hidden="true" /> Delete feature
            </Button>
            <span v-if="selectedRunIsActive" class="detail-muted">Stop the run before deleting. Your code files are kept.</span>
          </footer>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <DialogRoot v-model:open="featureDialogOpen">
      <DialogPortal>
        <DialogOverlay class="board-dialog-backdrop" />
        <DialogContent @interact-outside="isDictating && $event.preventDefault()" aria-modal="true" class="board-dialog" :aria-describedby="undefined" @open-auto-focus="rememberFocus('feature')" @close-auto-focus="restoreFocus('feature', $event)">
          <header><div><DialogTitle>{{ editingCardId ? 'Edit feature' : 'New feature' }}</DialogTitle><p>Give the Lead a clear brief. It will make the task plan.</p></div><Button type="button" variant="ghost" size="icon-sm" aria-label="Close" @click="featureDialogOpen = false"><X /></Button></header>
          <form class="board-form" data-testid="new-feature-form" @submit.prevent="createFeature">
            <p v-if="error" class="boards-alert" role="alert">{{ error }}</p>
            <label><span>Brief</span><DictationField v-model="featureDraft.description" label="Brief" v-bind="voiceField('feature-brief')" multiline rows="4" maxlength="20000" placeholder="What should be built, and why?" /></label>
            <label><span>{{ editingCardId ? 'Title' : 'Title (optional)' }}</span><DictationField v-model="featureDraft.title" label="Title" v-bind="voiceField('feature-title')" :required="!!editingCardId" maxlength="240" placeholder="Add project progress board" /></label>
            <p v-if="!editingCardId && !featureDraft.title.trim()" class="detail-muted break-words" data-testid="feature-title-preview">{{ suggestedFeatureTitle ? `Title from your brief: ${suggestedFeatureTitle}` : 'Leave the title blank to use a short title from your brief.' }}</p>
            <label><span>Done when</span><DictationField v-model="featureDraft.acceptanceCriteria" label="Done when" v-bind="voiceField('feature-acceptance')" multiline rows="3" placeholder="The result you expect" /></label>
            <div class="board-form-grid">
              <label><span>Priority</span><select v-model="featureDraft.priority"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
              <label><span>Verification</span><select v-model="featureDraft.verificationPolicy"><option value="none">None</option><option value="self">Self-check</option><option value="independent">Independent verification</option><option value="batch">Review later</option></select></label>
              <label><span>Lead for this feature</span><select v-model="featureDraft.assignedAgentId" aria-label="Lead for this feature"><option v-if="draftLeadUnavailable" :value="featureDraft.assignedAgentId" disabled>{{ agentFor(featureDraft.assignedAgentId)?.name ?? 'Assigned agent' }} · not on this board</option><option v-for="agent in boardAgents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
            </div>
            <BoardExecutionSettings v-model:model="featureDraft.model" v-model:reasoning-effort="featureDraft.reasoningEffort" :inherited-model="agentFor(featureDraft.assignedAgentId)?.model" :inherited-effort="agentFor(featureDraft.assignedAgentId)?.reasoningEffort" />
            <fieldset v-if="dependencyCandidates.length" class="dependency-picker"><legend>Depends on</legend><p class="detail-muted">Shared groundwork belongs in one feature. Select anything this feature needs first.</p><label v-for="feature in dependencyCandidates" :key="feature.id" class="checkbox-row"><input v-model="featureDraft.dependencyIds" type="checkbox" :value="feature.id" /><span>{{ feature.title }} · {{ statusLabel(feature.status) }}</span></label></fieldset>
            <p v-if="draftLeadUnavailable" class="boards-alert">Choose another Lead or enable the assigned agent in the Agent library.</p>
            <p class="verification-help">{{ verificationHelp[featureDraft.verificationPolicy] }}</p>
            <footer><Button type="button" variant="ghost" @click="featureDialogOpen = false">Cancel</Button><Button type="submit" :disabled="isDictating || isMutating || !hasFeatureContent">{{ editingCardId ? 'Save feature' : 'Create feature' }}</Button></footer>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <DialogRoot v-model:open="boardDialogOpen">
      <DialogPortal>
        <DialogOverlay class="board-dialog-backdrop" />
        <DialogContent @interact-outside="isDictating && $event.preventDefault()" aria-modal="true" class="board-dialog board-dialog-small" :aria-describedby="undefined" @open-auto-focus="rememberFocus('board')" @close-auto-focus="restoreFocus('board', $event)">
          <header><div><DialogTitle>New board</DialogTitle><p>Use another board for a release, experiment, or separate workstream.</p></div><Button type="button" variant="ghost" size="icon-sm" aria-label="Close" @click="boardDialogOpen = false"><X /></Button></header>
          <form class="board-form" @submit.prevent="createBoard">
            <p v-if="error" class="boards-alert" role="alert">{{ error }}</p>
            <label><span>Name</span><DictationField v-model="boardName" label="Name" v-bind="voiceField('board-name')" required placeholder="Project board" /></label>
            <label class="checkbox-row"><input v-model="boardIsDefault" type="checkbox" /><span>Make this the default board for the project</span></label>
            <footer><Button type="button" variant="ghost" @click="boardDialogOpen = false">Cancel</Button><Button type="submit" :disabled="isDictating || isMutating">Create board</Button></footer>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <DialogRoot v-model:open="agentDialogOpen">
      <DialogPortal>
        <DialogOverlay class="board-dialog-backdrop" />
        <DialogContent @interact-outside="isDictating && $event.preventDefault()" aria-modal="true" class="board-dialog agent-dialog" :aria-describedby="undefined" @open-auto-focus="rememberFocus('agents')" @close-auto-focus="restoreFocus('agents', $event)">
          <header><div><DialogTitle>Agent library</DialogTitle><p>Reusable agent profiles. Any agent can lead a feature or work on its tasks.</p></div><Button type="button" variant="ghost" size="icon-sm" aria-label="Close" @click="agentDialogOpen = false"><X /></Button></header>
          <p v-if="error" class="boards-alert" role="alert">{{ error }}</p>
          <p class="agent-access-note">Access is shared by the Lead and its subagents. If any selected agent can edit, read-only role instructions are guidance, not separate sandbox restrictions.</p>
          <div class="agent-dialog-body">
            <section>
              <h3>Available agents <span class="agent-help">· {{ boardAgents.length }} on this board</span></h3>
              <p class="agent-help">Checked agents are available on this board. Membership saves immediately.</p>
              <DictationField v-model="agentSearch" label="Find an agent" v-bind="voiceField('agent-search')" aria-label="Find an agent" placeholder="Find an agent" class="agent-search" />
              <p v-if="filteredAgents.length === 0" class="agent-help">No agents match your search.</p>
              <div v-for="agent in filteredAgents" :key="agent.id" class="agent-row" :class="{ 'is-editing': editingAgentId === agent.id }">
                <input :id="`board-agent-${agent.id}`" :checked="activeBoard?.agentIds.includes(agent.id)" type="checkbox" :disabled="isDictating || isMutating || !activeBoard || (activeBoard.agentIds.length === 1 && activeBoard.agentIds.includes(agent.id))" @change="toggleBoardAgent(agent.id, $event)" />
                <span class="agent-avatar">{{ agent.name.slice(0, 1).toUpperCase() }}</span>
                <label :for="`board-agent-${agent.id}`"><strong>{{ agent.name }}</strong><small>{{ agent.role }} · {{ agent.sandbox === 'workspace-write' ? 'requests project edits' : 'read-only instructions' }}</small><p>{{ agent.description }}</p></label>
                <Button type="button" variant="ghost" size="sm" :disabled="isDictating || isMutating || agentDraftIsDirty" :aria-label="`${agent.builtIn ? 'Customize' : 'Edit'} ${agent.name}`" @click="editAgent(agent)">{{ agent.builtIn ? 'Customize' : 'Edit' }}</Button>
              </div>
            </section>
            <form ref="agentEditor" class="new-agent-form" @submit.prevent="createAgent">
              <h3>{{ editingAgentId ? 'Edit agent' : copyingAgentName ? `Customize ${copyingAgentName}` : 'Add your own agent' }}</h3>
              <p v-if="agentFeedback" role="status" class="agent-help">{{ agentFeedback }}</p>
              <label><span>Name</span><DictationField v-model="agentDraft.name" label="Name" v-bind="voiceField('agent-name')" maxlength="120" required placeholder="Accessibility reviewer" /></label>
              <div class="board-form-grid"><label><span>Specialty</span><select v-model="agentDraft.role" aria-label="Specialty"><option value="custom">Custom</option><option value="product">Product</option><option value="design">Design</option><option value="engineering">Engineering</option><option value="qa">QA</option><option value="lead">Coordination</option></select></label><label><span>Access</span><select v-model="agentDraft.sandbox" aria-label="Access" :disabled="editingAgentAccessLocked"><option value="read-only">Read only</option><option value="workspace-write">Can edit project</option></select></label></div>
              <p v-if="editingAgentAccessLocked" class="agent-help">This agent has assigned work. Make a copy to change its access.</p>
              <label><span>Description</span><DictationField v-model="agentDraft.description" label="Description" v-bind="voiceField('agent-description')" maxlength="500" placeholder="What this specialist is for" /></label>
              <BoardExecutionSettings :model="agentDraft.model" :reasoning-effort="agentDraft.reasoningEffort" inherit-label="Use app default" label="Agent" :show-specialist-note="false" :allow-inherited-effort="false" @update:model="agentDraft.model = $event" @update:reasoning-effort="agentDraft.reasoningEffort = $event || agentDraft.reasoningEffort" />
              <label><span>Instructions</span><DictationField v-model="agentDraft.instructions" label="Instructions" v-bind="voiceField('agent-instructions')" multiline class="agent-instructions" maxlength="20000" required rows="9" placeholder="Describe the agent’s expertise, how it should work, and when it should ask for help." /></label>
              <p class="agent-help">This is the agent’s prompt. Saved changes apply when a feature starts or continues. New agents are added to this board.</p>
              <p v-if="agentDraftIsDirty" class="agent-draft-note">Unsaved changes. Save or cancel before choosing another agent.</p>
              <div class="boards-header-actions"><Button type="submit" size="sm" :disabled="isDictating || isMutating || !agentDraftIsDirty || !agentDraft.name.trim() || !agentDraft.instructions.trim()">{{ editingAgentId ? 'Save agent' : copyingAgentName ? 'Create copy' : 'Add agent' }}</Button><Button v-if="editingAgentId || agentDraftIsDirty" type="button" variant="ghost" size="sm" :disabled="isDictating || isMutating" @click="resetAgentEditor">Cancel</Button><Button v-if="editingAgentId && !agentDraftIsDirty" type="button" variant="ghost" size="sm" :disabled="isDictating || isMutating" @click="copyEditingAgent">Make a copy</Button></div>
            </form>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
    <DialogRoot v-model:open="queueDialogOpen"><DialogPortal><DialogOverlay class="board-dialog-backdrop" /><DialogContent @interact-outside="isDictating && $event.preventDefault()" class="board-dialog" aria-describedby="queue-description" @open-auto-focus="rememberFocus('queue')" @close-auto-focus="restoreFocus('queue', $event)">
      <header><div><DialogTitle>Run selected features</DialogTitle><p id="queue-description">The coordinator runs these features one at a time, following dependencies and each feature’s model and verification settings.</p></div><Button type="button" variant="ghost" size="icon-sm" aria-label="Close queue" @click="queueDialogOpen = false"><X /></Button></header>
      <form class="board-form" @submit.prevent="runQueue">
        <p v-if="error" class="boards-alert" role="alert">{{ error }}</p>
        <div class="queue-list"><label v-for="feature in queueCandidates" :key="feature.id" class="queue-feature"><input v-model="queueFeatureIds" type="checkbox" :value="feature.id" /><span><strong>{{ feature.title }}</strong><small>{{ dependencyLabel(feature) || 'Ready when the project is free' }}</small></span></label></div>
        <p class="detail-muted">Pauses for a question, failure, or review. New features are not added to this selection automatically. After a restart, select the remaining features again.</p>
        <label v-if="boardAgents.some(agent => agent.sandbox === 'workspace-write')" class="checkbox-row"><input v-model="queueAllowEdits" type="checkbox" /><span>Allow project edits for these selected features and their agents.</span></label>
        <footer><Button type="button" variant="ghost" @click="queueDialogOpen = false">Cancel</Button><Button type="submit" :disabled="isDictating || isMutating || !queueFeatureIds.length || (boardAgents.some(agent => agent.sandbox === 'workspace-write') && !queueAllowEdits)">Start selected features</Button></footer>
      </form>
    </DialogContent></DialogPortal></DialogRoot>

    <DialogRoot v-model:open="startDialogOpen">
      <DialogPortal>
        <DialogOverlay class="board-dialog-backdrop" />
        <DialogContent @interact-outside="isDictating && $event.preventDefault()" aria-modal="true" class="board-dialog board-dialog-small" aria-describedby="board-start-description" @open-auto-focus="rememberFocus('start')" @close-auto-focus="restoreFocus('start', $event)">
          <header><DialogTitle>Allow project edits?</DialogTitle></header>
          <div class="board-form">
            <p id="board-start-description" class="detail-prewrap">Starting this feature gives the Lead and all its native subagents shared access to edit files in this project. Read-only role instructions do not restrict individual agents. Automatic handoffs keep this access until the run ends.</p>
            <p v-if="error" class="boards-alert" role="alert">{{ error }}</p>
            <footer><Button type="button" variant="ghost" @click="startDialogOpen = false">Cancel</Button><Button type="button" :disabled="isDictating || isMutating" @click="confirmStart">Allow edits &amp; start</Button></footer>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { projectBoardTitleFromBrief } from '../../lib/projectBoardTitle'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from 'reka-ui'
import {
  Check,
  ChevronDown,
  CircleHelp,
  FileText,
  FolderKanban,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Users,
  X,
} from '@lucide/vue'
import type { ProjectBoardUpdateInput, ProjectBoardCardUpdateInput, ProjectBoardAgentUpdateInput } from '../../api/projectBoards'
import Button from '../ui/button/Button.vue'
import DictationField from './DictationField.vue'
import BoardExecutionSettings from './BoardExecutionSettings.vue'
import BoardDailyViews from './BoardDailyViews.vue'
import type { ReasoningEffort, UiServerRequest } from '../../types/codex'
import type {
  ProjectBoard,
  ProjectBoardAgent,
  ProjectBoardAgentCreateInput,
  ProjectBoardCard,
  ProjectBoardCardCreateInput,
  ProjectBoardPriority,
  ProjectBoardRunStatus,
  ProjectBoardSnapshot,
  ProjectBoardStatus,
  ProjectBoardVerificationPolicy,
} from '../../types/projectBoards'

type ProjectOption = { path: string; name: string }
type BoardActions = {
  clearError: () => void
  ensureBoard: (input: { projectPath: string; projectName: string }) => Promise<unknown>
  createBoard: (input: { projectPath: string; projectName: string; name: string; isDefault: boolean }) => Promise<unknown>
  updateBoard: (boardId: string, changes: ProjectBoardUpdateInput) => Promise<unknown>
  createAgent: (input: ProjectBoardAgentCreateInput) => Promise<unknown>
  updateAgent: (agentId: string, changes: ProjectBoardAgentUpdateInput) => Promise<unknown>
  createCard: (input: ProjectBoardCardCreateInput) => Promise<unknown>
  updateCard: (cardId: string, changes: ProjectBoardCardUpdateInput) => Promise<unknown>
  deleteCard: (cardId: string) => Promise<unknown>
  addComment: (cardId: string, text: string) => Promise<unknown>
  answerQuestion: (questionId: string, answer: string) => Promise<unknown>
  startFeature: (featureId: string, allowWorkspaceWrite: boolean, mode?: 'plan' | 'execute') => Promise<unknown>
  startQueue: (boardId: string, featureIds: string[], allowWorkspaceWrite: boolean) => Promise<unknown>
  stopQueue: (boardId: string) => Promise<unknown>
  stopFeature: (featureId: string, expectedRunId?: string) => Promise<unknown>
}

const props = defineProps<{
  snapshot: ProjectBoardSnapshot
  isLoading: boolean
  isMutating: boolean
  actions: BoardActions
  error: string
  projects: ProjectOption[]
  pendingRequests?: UiServerRequest[]
  initialBoardId?: string
  initialFeatureId?: string
  initialQuestionId?: string
  initialProjectPath?: string
}>()

const emit = defineEmits<{
  'select-project': [projectPath: string]
  'select-board': [boardId: string]
  'select-feature': [featureId: string, boardId: string, questionId?: string]
  'select-thread': [threadId: string]
  'plan-board': [boardId: string]
}>()

const columns: Array<{ key: string; label: string; hint: string; statuses: ProjectBoardStatus[]; moveStatus: ProjectBoardStatus; tone: string }> = [
  { key: 'backlog', label: 'Backlog', hint: 'Review a plan or choose what starts next', statuses: ['backlog'], moveStatus: 'backlog', tone: 'muted' },
  { key: 'working', label: 'In progress', hint: 'Your agents are working on these', statuses: ['working'], moveStatus: 'working', tone: 'blue' },
  { key: 'needs-you', label: 'Needs you', hint: 'A decision or next step needs attention', statuses: ['needs_input', 'blocked'], moveStatus: 'blocked', tone: 'amber' },
  { key: 'review', label: 'Review', hint: 'Built and waiting for its final check', statuses: ['review'], moveStatus: 'review', tone: 'violet' },
  { key: 'done', label: 'Done', hint: 'Completed with a recorded result', statuses: ['done'], moveStatus: 'done', tone: 'green' },
]

const moveStatuses: Array<{ value: ProjectBoardStatus; label: string }> = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'working', label: 'In progress' },
  { value: 'needs_input', label: 'Needs input' },
  { value: 'review', label: 'Review' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
]

const draggedCardId = ref('')
const featureDialogOpen = ref(false)
const editingCardId = ref('')
const boardDialogOpen = ref(false)
const agentDialogOpen = ref(false)
const editingAgentId = ref('')
const copyingAgentName = ref('')
const agentSearch = ref('')
const agentFeedback = ref('')
const agentEditor = ref<HTMLFormElement | null>(null)
const boardName = ref('')
const boardIsDefault = ref(false)
const questionAnswer = ref('')
const commentText = ref('')
const startDialogOpen = ref(false)
const queueDialogOpen = ref(false)
const queueFeatureIds = ref<string[]>([])
const queueAllowEdits = ref(false)
const featureSearch = ref('')
const boardViews = [{ id: 'board', label: 'Board' }, { id: 'needs-you', label: 'Needs you' }, { id: 'runs', label: 'Runs' }] as const
type BoardView = typeof boardViews[number]['id']
const activeView = ref<BoardView>('board')
const busyVoiceFields = reactive(new Set<string>())
const isDictating = computed(() => busyVoiceFields.size > 0)
function voiceField(key: string) {
  return { dictationDisabled: isDictating.value && !busyVoiceFields.has(key), onBusyChange: (busy: boolean) => { if (busy) busyVoiceFields.add(key); else busyVoiceFields.delete(key) } }
}
watch([featureDialogOpen, boardDialogOpen, agentDialogOpen, startDialogOpen, queueDialogOpen], (open, previous) => {
  if (open.some((value, index) => value && !previous[index])) props.actions.clearError()
})
const isDockedDetail = useMediaQuery('(min-width: 1280px) and (pointer: fine)')
const focusBeforeDialog = new Map<string, HTMLElement>()

const featureDraft = reactive({
  title: '',
  description: '',
  acceptanceCriteria: '',
  priority: 'normal' as ProjectBoardPriority,
  verificationPolicy: 'self' as ProjectBoardVerificationPolicy,
  assignedAgentId: '',
  dependencyIds: [] as string[],
  model: '',
  reasoningEffort: '' as ReasoningEffort | '',
})

const agentDraft = reactive({
  name: '',
  role: 'custom',
  description: '',
  instructions: '',
  sandbox: 'read-only',
  model: '',
  reasoningEffort: 'high' as ProjectBoardAgent['reasoningEffort'],
})
const initialAgentDraft = ref(JSON.stringify(agentDraft))
const agentDraftIsDirty = computed(() => JSON.stringify(agentDraft) !== initialAgentDraft.value)
const editingAgentAccessLocked = computed(() => Boolean(editingAgentId.value) && props.snapshot.cards.some((card) => card.assignedAgentId === editingAgentId.value))
const filteredAgents = computed(() => {
  const query = agentSearch.value.trim().toLowerCase()
  return props.snapshot.agents.filter((agent) => `${agent.name} ${agent.role} ${agent.description}`.toLowerCase().includes(query))
})
const draftLeadUnavailable = computed(() => Boolean(featureDraft.assignedAgentId) && !boardAgents.value.some((agent) => agent.id === featureDraft.assignedAgentId))
const verificationHelp: Record<ProjectBoardVerificationPolicy, string> = {
  none: 'No separate verification step. Use for work that does not need additional checks.',
  self: 'The agent records combined checks once the feature is ready.',
  independent: 'A fresh review checks the finished feature after all work tasks. Any suitable agent can perform it.',
  batch: 'Completed work waits in Review for manual combined verification.',
}

const projectOptions = computed<ProjectOption[]>(() => {
  const seen = new Set<string>()
  const options: ProjectOption[] = []
  for (const project of props.projects) {
    if (!project.path || seen.has(project.path)) continue
    seen.add(project.path)
    options.push(project)
  }
  for (const board of props.snapshot.boards) {
    if (seen.has(board.projectPath)) continue
    seen.add(board.projectPath)
    options.push({ path: board.projectPath, name: board.projectName })
  }
  return options
})

const selectedProjectPath = computed({
  get: () => props.snapshot.boards.find((board) => board.id === props.initialBoardId)?.projectPath
    || props.initialProjectPath || projectOptions.value[0]?.path || '',
  set: (path: string) => emit('select-project', path),
})
const projectBoards = computed(() => props.snapshot.boards.filter((board) => board.projectPath === selectedProjectPath.value))
const activeBoard = computed<ProjectBoard | null>(() => {
  if (props.initialBoardId) return projectBoards.value.find((board) => board.id === props.initialBoardId) ?? null
  return projectBoards.value.find((board) => board.isDefault) ?? projectBoards.value[0] ?? null
})
const boardAgents = computed(() => props.snapshot.agents.filter((agent) => activeBoard.value?.agentIds.includes(agent.id)))
const featureCards = computed(() => props.snapshot.cards.filter((card) => card.boardId === activeBoard.value?.id && !card.parentCardId))
const openBoardQuestions = computed(() => props.snapshot.questions.filter((question) => question.boardId === activeBoard.value?.id && question.status === 'open').sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso)))
const attentionCards = computed(() => featureCards.value.filter((card) => requestForCard(card) || card.status === 'blocked' || card.status === 'review' || (card.status === 'needs_input' && !openQuestionFor(card))))
const attentionCount = computed(() => openBoardQuestions.value.length + attentionCards.value.length)
const workingFeatureCount = computed(() => featureCards.value.filter((card) => cardDisplayStatus(card) === 'working').length)
const completedFeatureCount = computed(() => featureCards.value.filter((card) => card.status === 'done').length)
const dependencyCandidates = computed(() => featureCards.value.filter((card) => card.type === 'feature' && card.id !== editingCardId.value))
const activeQueue = computed(() => props.snapshot.queues?.find((queue) => queue.boardId === activeBoard.value?.id))
const queueCandidates = computed(() => featureCards.value.filter((card) => card.type === 'feature' && card.status !== 'done' && card.status !== 'review' && !cardIsLocked(card)))
const latestBoardPlanRun = computed(() => props.snapshot.runs.filter((run) => run.boardId === activeBoard.value?.id && run.kind === 'board_plan').sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso))[0])
const boardPlanningActive = computed(() => latestBoardPlanRun.value?.status === 'running' || latestBoardPlanRun.value?.status === 'queued')
const selectedCard = computed(() => featureCards.value.find((card) => card.id === props.initialFeatureId) ?? null)
const selectedTasks = computed(() => props.snapshot.cards.filter((card) => card.parentCardId === selectedCard.value?.id).sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso)))
const selectedTaskIds = computed(() => new Set(selectedTasks.value.map((task) => task.id)))
const selectedQuestions = computed(() => props.snapshot.questions.filter((question) => question.boardId === activeBoard.value?.id && question.status === 'open' && (question.cardId === selectedCard.value?.id || selectedTaskIds.value.has(question.cardId))))
const selectedOpenQuestion = computed(() => selectedQuestions.value.find((question) => question.id === props.initialQuestionId) ?? selectedQuestions.value[0] ?? null)
const selectedArtifacts = computed(() => props.snapshot.artifacts.filter((artifact) => artifact.cardId === selectedCard.value?.id || selectedTaskIds.value.has(artifact.cardId)))
const selectedRuns = computed(() => props.snapshot.runs.filter((run) => run.cardId === selectedCard.value?.id).sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso)))
const selectedComments = computed(() => props.snapshot.comments.filter((comment) => comment.cardId === selectedCard.value?.id || selectedTaskIds.value.has(comment.cardId)).sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso)))
const selectedRunIsActive = computed(() => selectedRuns.value.some((run) => run.status === 'running' || run.status === 'queued'))
const canStartSelectedCard = computed(() => selectedCard.value?.type === 'feature' && selectedCard.value.status !== 'done' && selectedCard.value.status !== 'review')

watch(() => activeBoard.value?.id, () => { activeView.value = 'board' })
watch([() => activeBoard.value?.id, () => props.initialFeatureId, selectedProjectPath], () => {
  questionAnswer.value = ''
  commentText.value = ''
  featureDialogOpen.value = false
  startDialogOpen.value = false
  queueDialogOpen.value = false
  featureSearch.value = ''
})
watch(() => selectedOpenQuestion.value?.id, () => { questionAnswer.value = '' })

watch(activeBoard, (board) => {
  if (!board) return
  if (!board.agentIds.includes(featureDraft.assignedAgentId)) {
    featureDraft.assignedAgentId = boardAgents.value.find((agent) => agent.role === 'lead')?.id ?? board.agentIds[0] ?? ''
  }
})

function cardsForColumn(statuses: ProjectBoardStatus[]): ProjectBoardCard[] {
  const query = featureSearch.value.trim().toLowerCase()
  return featureCards.value.filter((card) => statuses.includes(cardDisplayStatus(card)) && (!query || `${card.title} ${card.description} ${agentFor(card.assignedAgentId)?.name || ''}`.toLowerCase().includes(query))).sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso))
}

function navigateBoardView(event: KeyboardEvent, view: BoardView): void {
  const index = boardViews.findIndex((entry) => entry.id === view)
  const next = event.key === 'ArrowRight' ? (index + 1) % boardViews.length
    : event.key === 'ArrowLeft' ? (index + boardViews.length - 1) % boardViews.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? boardViews.length - 1 : -1
  if (next < 0) return
  event.preventDefault()
  activeView.value = boardViews[next]!.id
  const tablist = (event.currentTarget as HTMLElement).parentElement
  tablist?.querySelector<HTMLButtonElement>(`[data-board-view="${activeView.value}"]`)?.focus()
}

function selectBoardFromEvent(event: Event): void {
  const boardId = (event.target as HTMLSelectElement).value
  if (boardId) emit('select-board', boardId)
}

function selectCard(card: ProjectBoardCard): void {
  emit('select-feature', card.id, card.boardId)
}

function closeCard(): void {
  emit('select-feature', '', activeBoard.value?.id ?? '')
}

function ensureSelectedProjectBoard(): void {
  const project = projectOptions.value.find((entry) => entry.path === selectedProjectPath.value)
  if (project) void submitMutation(() => props.actions.ensureBoard({ projectPath: project.path, projectName: project.name }))
}

function openBoardEditor(): void {
  boardName.value = projectBoards.value.length === 0 ? 'Project board' : `Board ${projectBoards.value.length + 1}`
  boardIsDefault.value = projectBoards.value.length === 0
  boardDialogOpen.value = true
}

function createBoard(): void {
  const project = projectOptions.value.find((entry) => entry.path === selectedProjectPath.value)
  if (!project || !boardName.value.trim()) return
  void submitMutation(() => props.actions.createBoard({ projectPath: project.path, projectName: project.name, name: boardName.value.trim(), isDefault: boardIsDefault.value }), () => { boardDialogOpen.value = false })
}

function openFeatureEditor(): void {
  editingCardId.value = ''
  featureDraft.title = ''
  featureDraft.description = ''
  featureDraft.acceptanceCriteria = ''
  featureDraft.priority = 'normal'
  featureDraft.verificationPolicy = 'self'
  featureDraft.model = ''
  featureDraft.reasoningEffort = ''
  featureDraft.dependencyIds = []
  featureDraft.assignedAgentId = boardAgents.value.find((agent) => agent.role === 'lead')?.id ?? boardAgents.value[0]?.id ?? ''
  featureDialogOpen.value = true
}

function openEditSelectedCard(): void {
  if (!selectedCard.value) return
  editingCardId.value = selectedCard.value.id
  featureDraft.title = selectedCard.value.title
  featureDraft.description = selectedCard.value.description
  featureDraft.acceptanceCriteria = selectedCard.value.acceptanceCriteria
  featureDraft.priority = selectedCard.value.priority
  featureDraft.verificationPolicy = selectedCard.value.verificationPolicy
  featureDraft.assignedAgentId = selectedCard.value.assignedAgentId
  featureDraft.dependencyIds = [...selectedCard.value.dependencyIds]
  featureDraft.model = selectedCard.value.model || ''
  featureDraft.reasoningEffort = selectedCard.value.reasoningEffort || ''
  featureDialogOpen.value = true
}

const suggestedFeatureTitle = computed(() => projectBoardTitleFromBrief(featureDraft.description))
const hasFeatureContent = computed(() => Boolean(featureDraft.title.trim() || (!editingCardId.value && suggestedFeatureTitle.value)))

function createFeature(): void {
  const board = activeBoard.value
  if (!board || !hasFeatureContent.value) return
  const changes = {
    title: featureDraft.title.trim(), description: featureDraft.description,
    acceptanceCriteria: featureDraft.acceptanceCriteria, priority: featureDraft.priority,
    verificationPolicy: featureDraft.verificationPolicy, assignedAgentId: featureDraft.assignedAgentId,
    dependencyIds: [...featureDraft.dependencyIds], model: featureDraft.model, reasoningEffort: featureDraft.reasoningEffort,
  }
  void submitMutation(() => editingCardId.value
    ? props.actions.updateCard(editingCardId.value, changes)
    : props.actions.createCard({ boardId: board.id, ...changes, type: 'feature' }),
  () => { featureDialogOpen.value = false })
}

function resetAgentEditor(): void {
  editingAgentId.value = ''
  copyingAgentName.value = ''
  agentFeedback.value = ''
  Object.assign(agentDraft, { name: '', description: '', instructions: '', role: 'custom', sandbox: 'read-only', model: '', reasoningEffort: 'high' })
  initialAgentDraft.value = JSON.stringify(agentDraft)
}

function editAgent(agent: ProjectBoardAgent, copy = agent.builtIn): void {
  if (agentDraftIsDirty.value) return
  resetAgentEditor()
  editingAgentId.value = copy ? '' : agent.id
  copyingAgentName.value = copy ? agent.name : ''
  Object.assign(agentDraft, {
    name: copy ? `${agent.name} copy` : agent.name,
    description: agent.description, instructions: agent.instructions,
    role: agent.role, sandbox: agent.sandbox, model: agent.model, reasoningEffort: agent.reasoningEffort,
  })
  if (!copy) initialAgentDraft.value = JSON.stringify(agentDraft)
  void nextTick(() => {
    agentEditor.value?.scrollIntoView({ block: 'nearest' })
    agentEditor.value?.querySelector('input')?.focus({ preventScroll: true })
  })
}

function copyEditingAgent(): void {
  const agent = agentFor(editingAgentId.value)
  if (agent) editAgent(agent, true)
}

function createAgent(): void {
  if (!agentDraft.name.trim() || !agentDraft.instructions.trim()) return
  const input = {
    ...agentDraft,
    role: agentDraft.role as ProjectBoardAgentCreateInput['role'],
    sandbox: agentDraft.sandbox as ProjectBoardAgentCreateInput['sandbox'],
    name: agentDraft.name.trim(), instructions: agentDraft.instructions.trim(),
  }
  const agentId = editingAgentId.value
  void submitMutation(() => agentId ? props.actions.updateAgent(agentId, input) : props.actions.createAgent({ ...input, boardId: activeBoard.value?.id }), () => {
    resetAgentEditor()
    agentFeedback.value = `${input.name} saved.`
  })
}

function toggleBoardAgent(agentId: string, event: Event): void {
  if (!activeBoard.value) return
  const checkbox = event.target as HTMLInputElement
  const checked = checkbox.checked
  checkbox.checked = activeBoard.value.agentIds.includes(agentId)
  const ids = checked
    ? Array.from(new Set([...activeBoard.value.agentIds, agentId]))
    : activeBoard.value.agentIds.filter((id) => id !== agentId)
  const boardId = activeBoard.value.id
  if (ids.length > 0) void submitMutation(() => props.actions.updateBoard(boardId, { agentIds: ids }))
}

function toggleAutoDispatch(event: Event): void {
  if (!activeBoard.value) return
  const boardId = activeBoard.value.id
  const checkbox = event.target as HTMLInputElement
  const autoDispatch = checkbox.checked
  checkbox.checked = activeBoard.value.autoDispatch
  void submitMutation(() => props.actions.updateBoard(boardId, { autoDispatch }))
}

function moveCardFromEvent(card: ProjectBoardCard, event: Event): void {
  const select = event.target as HTMLSelectElement
  const status = select.value as ProjectBoardStatus
  if (status && status !== card.status) void submitMutation(() => props.actions.updateCard(card.id, { status }))
  select.value = card.status
}

function dropOnColumn(status: ProjectBoardStatus): void {
  if (!draggedCardId.value) return
  const card = props.snapshot.cards.find((entry) => entry.id === draggedCardId.value)
  draggedCardId.value = ''
  if (card && !cardIsLocked(card) && card.status !== status) void submitMutation(() => props.actions.updateCard(card.id, { status }))
}

function startSelectedCard(): void {
  if (boardAgents.value.some((agent) => agent.sandbox === 'workspace-write')) startDialogOpen.value = true
  else runSelectedFeature(false)
}

function confirmStart(): void { runSelectedFeature(true) }
function planSelectedFeature(): void {
  const cardId = selectedCard.value?.id
  if (cardId) void submitMutation(() => props.actions.startFeature(cardId, false, 'plan'))
}
function openQueue(): void {
  const previous = new Set(activeQueue.value?.featureIds || [])
  queueFeatureIds.value = queueCandidates.value.filter((card) => !previous.size || previous.has(card.id)).map((card) => card.id)
  queueAllowEdits.value = false
  queueDialogOpen.value = true
}
function runQueue(): void {
  const boardId = activeBoard.value?.id
  if (boardId) void submitMutation(() => props.actions.startQueue(boardId, [...queueFeatureIds.value], queueAllowEdits.value), () => { queueDialogOpen.value = false })
}
function pauseQueue(): void {
  const boardId = activeBoard.value?.id
  if (boardId) void submitMutation(() => props.actions.stopQueue(boardId))
}
function dependencyLabel(card: ProjectBoardCard): string {
  if (!card.dependencyIds.length) return ''
  const dependencies = card.dependencyIds.map((id) => props.snapshot.cards.find((entry) => entry.id === id))
  const waiting = dependencies.filter((entry) => !entry || entry.status !== 'done')
  return `${waiting.length ? 'Waiting for' : 'Builds on'}: ${(waiting.length ? waiting : dependencies).map((entry) => entry?.title || 'Missing feature').join(', ')}`
}
function runSelectedFeature(allowWorkspaceWrite: boolean): void {
  const cardId = selectedCard.value?.id
  if (cardId) void submitMutation(() => props.actions.startFeature(cardId, allowWorkspaceWrite), () => { startDialogOpen.value = false })
}

function answerSelectedQuestion(): void {
  const questionId = selectedOpenQuestion.value?.id
  if (!questionId || !questionAnswer.value.trim()) return
  const answer = questionAnswer.value.trim()
  void submitMutation(() => props.actions.answerQuestion(questionId, answer), () => { questionAnswer.value = '' })
}

function addSelectedComment(): void {
  const cardId = selectedCard.value?.id
  if (!cardId || !commentText.value.trim()) return
  const text = commentText.value.trim()
  void submitMutation(() => props.actions.addComment(cardId, text), () => { if (selectedCard.value?.id === cardId) commentText.value = '' })
}

function requestForCard(card: ProjectBoardCard): UiServerRequest | undefined {
  return card.threadId ? props.pendingRequests?.find((request) => request.threadId === card.threadId) : undefined
}
function cardDisplayStatus(card: ProjectBoardCard): ProjectBoardStatus {
  return requestForCard(card) ? 'needs_input' : card.status
}
function nativeRequestLabel(card: ProjectBoardCard): string {
  return requestForCard(card)?.method.includes('requestUserInput') ? 'Answer needed' : 'Approval needed'
}
const stoppingFeatureId = ref('')
async function stopSelectedFeature(): Promise<void> {
  const card = selectedCard.value
  const run = selectedRuns.value.find((entry) => entry.status === 'running' || entry.status === 'queued')
  if (!card || !run || props.isMutating) return
  stoppingFeatureId.value = card.id
  try { await submitMutation(() => props.actions.stopFeature(card.id, run.id)) }
  finally { if (stoppingFeatureId.value === card.id) stoppingFeatureId.value = '' }
}

function deleteSelectedCard(): void {
  const card = selectedCard.value
  if (!card || selectedRunIsActive.value || !window.confirm(`Delete “${card.title}” and its board history? Your code files and Lead chat are kept.`)) return
  void submitMutation(() => props.actions.deleteCard(card.id), closeCard)
}

async function submitMutation(operation: () => Promise<unknown>, onSuccess?: () => void): Promise<void> {
  if (props.isMutating || isDictating.value) return
  try { await operation(); onSuccess?.() } catch { /* The shared error is shown alongside the preserved form. */ }
}

function cardIsLocked(card: ProjectBoardCard): boolean {
  return Boolean(openQuestionFor(card)) || props.snapshot.runs.some((run) => run.cardId === card.id && (run.status === 'running' || run.status === 'queued'))
}

function selectQuestion(event: Event): void {
  if (selectedCard.value) emit('select-feature', selectedCard.value.id, selectedCard.value.boardId, (event.target as HTMLSelectElement).value)
}

function keepDockedDetailOpen(event: Event): void { if (isDockedDetail.value || isDictating.value) event.preventDefault() }
function rememberFocus(dialog: string): void {
  if (document.activeElement instanceof HTMLElement) focusBeforeDialog.set(dialog, document.activeElement)
}
function restoreFocus(dialog: string, event: Event): void {
  const element = focusBeforeDialog.get(dialog)
  if (element?.isConnected) { event.preventDefault(); element.focus() }
  focusBeforeDialog.delete(dialog)
}

function agentFor(id: string): ProjectBoardAgent | undefined { return props.snapshot.agents.find((agent) => agent.id === id) }
function openQuestionFor(card: ProjectBoardCard) { const ids = new Set(props.snapshot.cards.filter((task) => task.parentCardId === card.id).map((task) => task.id)); return props.snapshot.questions.find((question) => question.status === 'open' && (question.cardId === card.id || ids.has(question.cardId))) }
function taskProgress(card: ProjectBoardCard): string { const tasks = props.snapshot.cards.filter((task) => task.parentCardId === card.id); return tasks.length === 0 ? 'Not planned' : `${tasks.filter((task) => task.status === 'done').length}/${tasks.length} tasks` }
function priorityLabel(priority: ProjectBoardPriority): string { return priority === 'normal' ? 'Feature' : `${priority[0].toUpperCase()}${priority.slice(1)} priority` }
function statusLabel(status: ProjectBoardStatus): string { return moveStatuses.find((entry) => entry.value === status)?.label ?? status }
function runStatusLabel(status: ProjectBoardRunStatus): string { return status === 'succeeded' ? 'Done' : status === 'running' ? 'Working' : status === 'queued' ? 'Queued' : status === 'interrupted' ? 'Interrupted' : 'Failed' }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
</script>

<style scoped>
@reference "tailwindcss";

.boards-hub { @apply flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 sm:px-5; color: var(--text-primary); }
.boards-header { @apply flex flex-wrap items-start justify-between gap-4 border-b py-4; border-color: var(--border-soft); }
.boards-heading-copy { @apply max-w-2xl; }
.boards-heading-copy h2 { @apply m-0 text-xl font-semibold tracking-tight; }
.boards-heading-copy p { @apply mt-1.5 mb-0 text-sm leading-5; color: var(--text-secondary); }
.boards-header-actions { @apply flex flex-wrap items-center gap-2; }
.boards-header-actions svg, .board-detail-actions svg, .lane-add svg, .new-agent-form button svg { @apply h-4 w-4; }
.boards-toolbar { @apply flex min-h-14 flex-wrap items-end gap-3 py-2.5; }
.boards-toolbar label { @apply flex min-w-0 flex-col gap-1; }
.boards-toolbar label > span, .board-form label > span, .detail-status-select > span, .new-agent-form label > span { @apply text-[11px] font-medium; color: var(--text-muted); }
.boards-toolbar select, .board-form select, .detail-status-select select, .board-card-move select, .new-agent-form select, .question-picker select { @apply h-9 rounded-md border px-2 text-sm outline-none; background: var(--surface-elevated); border-color: var(--border-strong); color: var(--text-primary); }
.boards-toolbar select:focus, .board-form select:focus { @apply ring-2 ring-blue-500/25; border-color: var(--accent-blue); }
.boards-toolbar .boards-auto-toggle { @apply ml-auto flex cursor-pointer flex-row items-center gap-2 pb-2 text-xs; color: var(--text-tertiary); }
.boards-auto-toggle input { @apply h-4 w-4 accent-blue-600; }
.boards-auto-toggle small { background: var(--surface-muted); @apply rounded-full px-2 py-0.5 text-[10px]; }
.boards-live-dot { @apply h-2 w-2 rounded-full bg-emerald-500; }
.board-workflow { @apply mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3; background: var(--surface-muted); border-color: var(--border-soft); }
.workflow-state { @apply min-w-0 flex-1; }
.workflow-state strong { @apply text-sm font-medium; }
.workflow-state p { @apply mt-1 mb-0 text-xs leading-5; color: var(--text-secondary); }
.board-plan-summary { @apply w-full text-xs; color: var(--text-secondary); }
.board-plan-summary summary { @apply cursor-pointer py-1; }
.board-plan-summary p { @apply max-h-60 overflow-y-auto whitespace-pre-wrap leading-5; }
.dependency-note { @apply text-xs leading-5; color: var(--text-tertiary); }
.dependency-picker { @apply flex max-h-52 flex-col gap-2 overflow-y-auto rounded-lg border p-3; border-color: var(--border-soft); }
.dependency-picker legend { @apply px-1 text-xs font-medium; }
.dependency-picker .checkbox-row { @apply flex-row items-center gap-2; }
.queue-list { @apply flex max-h-[40dvh] flex-col gap-2 overflow-y-auto; }
.queue-feature { @apply flex flex-row items-start gap-3 rounded-lg border p-3; border-color: var(--border-soft); }
.queue-feature input { @apply mt-1 h-4 w-4 flex-none; }
.queue-feature span { @apply flex min-w-0 flex-col gap-1; }
.queue-feature strong { @apply text-sm font-medium; color: var(--text-primary); }
.queue-feature small { @apply text-xs font-normal; color: var(--text-tertiary); }
.boards-alert { @apply m-0 rounded-lg border px-3 py-2 text-sm; color: var(--text-primary); background: color-mix(in srgb, var(--surface-elevated) 90%, #e11d48); border-color: color-mix(in srgb, var(--border-strong) 60%, #e11d48); }
.board-overview { @apply mb-3 flex flex-wrap items-center justify-between gap-3; }
.board-view-tabs { @apply mb-4 flex shrink-0 gap-1 border-b; border-color: var(--border-soft); }
.board-view-tabs button { @apply flex min-h-10 items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium; color: var(--text-secondary); }
.board-view-tabs button[aria-selected='true'] { color: var(--text-primary); border-color: var(--text-primary); }
.board-view-tabs button span { @apply rounded-full px-1.5 py-0.5 text-[10px]; background: var(--surface-muted); }
.board-view-panel { @apply flex min-h-0 min-w-0 flex-1 flex-col; }
.board-score { @apply flex flex-wrap items-center gap-x-4 gap-y-2 text-xs; color: var(--text-secondary); }
.board-score > span, .board-score > button { @apply inline-flex items-center gap-1.5; }
.board-score > button { @apply rounded-md px-1 py-2 hover:underline disabled:cursor-default disabled:no-underline; }
.board-overview > .dictation-field { @apply max-w-64; }
.agent-avatar { @apply h-5 w-5 justify-center rounded-md text-[10px] font-semibold; background: var(--surface-muted); color: var(--text-secondary); }
.lane-hint { @apply mt-0 mb-3 px-3 text-[11px] leading-4; color: var(--text-tertiary); }
.boards-empty { @apply m-auto flex max-w-lg flex-col items-center justify-center gap-2 px-6 py-12 text-center; color: var(--text-secondary); }
.boards-empty svg { @apply h-8 w-8; color: var(--text-muted); }
.boards-empty strong { @apply text-base; color: var(--text-primary); }
.boards-empty span { @apply text-sm leading-5; }
.boards-empty-compact { @apply my-8; }
.boards-lanes { @apply flex min-h-0 min-w-0 flex-1 overscroll-contain gap-3 overflow-x-auto overflow-y-hidden pb-4; scrollbar-width: thin; }
.board-lane { @apply flex min-h-0 shrink-0 flex-col rounded-xl border border-transparent; width: clamp(15.5rem, calc((100vw - 23rem) / 5), 19rem); }
.board-lane > header { @apply flex h-11 shrink-0 items-center gap-2 px-3; }
.board-lane > header h3 { @apply m-0 text-sm font-medium; }
.board-lane > header > span:last-child { @apply ml-auto text-xs; color: var(--text-muted); }
.lane-status-dot { @apply h-2 w-2 rounded-full bg-zinc-400; }
.lane-status-dot[data-tone='blue'] { @apply bg-blue-500; }
.lane-status-dot[data-tone='amber'] { @apply bg-amber-500; }
.lane-status-dot[data-tone='violet'] { @apply bg-violet-500; }
.lane-status-dot[data-tone='green'] { @apply bg-emerald-500; }
.board-lane-list { @apply min-h-0 overscroll-contain flex-1 space-y-2 overflow-y-auto px-2 pb-2; }
.board-card { background: var(--surface-elevated); @apply relative overflow-hidden rounded-lg border shadow-sm transition hover:-translate-y-px hover:shadow-md; border-color: var(--border-soft); }
.board-card.is-selected { @apply ring-2 ring-blue-500/25; border-color: var(--accent-blue); }
.board-card-main { @apply block w-full border-0 bg-transparent px-3 pt-3 pb-9 text-left; color: inherit; }
.board-card-kicker { @apply mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide; color: var(--text-muted); }
.needs-you-pill { @apply rounded-full bg-amber-100 px-2 py-0.5 text-amber-800; }
.board-card-main > strong { @apply block text-sm font-semibold leading-5; }
.board-card-main > p { @apply mt-1.5 mb-0 line-clamp-2 text-xs leading-[1.15rem]; color: var(--text-secondary); }
.board-card-meta { @apply mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]; color: var(--text-tertiary); }
.board-card-meta span { @apply inline-flex items-center gap-1; }
.board-card-meta svg { @apply h-3.5 w-3.5; }
.board-card-move { @apply absolute right-2 bottom-2 flex items-center; }
.board-card-move select { @apply h-6 max-w-28 cursor-pointer appearance-none border-0 bg-transparent pr-5 text-[10px]; color: var(--text-muted); }
.board-card-move svg { @apply pointer-events-none absolute right-0.5 h-3 w-3; color: var(--text-muted); }
.lane-add { @apply flex h-9 w-full items-center justify-center gap-1 rounded-lg border border-dashed bg-transparent text-xs transition; border-color: var(--border-strong); color: var(--text-tertiary); }
.board-panel-backdrop, .board-dialog-backdrop { @apply fixed inset-0 z-40 bg-zinc-950/30 backdrop-blur-[1px]; }
.board-dialog-backdrop { @apply z-[60]; }
.board-detail-panel { @apply fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[42rem] flex-col overflow-hidden border-l shadow-2xl outline-none; background: var(--surface-elevated); color: var(--text-primary); border-color: var(--border-soft); }
.board-detail-header { @apply flex items-start justify-between gap-4 border-b px-5 py-4; border-color: var(--border-soft); }
.board-detail-header span { @apply text-xs font-medium; color: var(--text-muted); }
.board-detail-header :deep(h2) { @apply mt-1 mb-0 text-xl font-semibold tracking-tight; }
.board-detail-header svg, .board-dialog header svg { @apply h-4 w-4; }
.board-detail-body { @apply min-h-0 overscroll-contain flex-1 space-y-5 overflow-y-auto px-5 py-4; }
.board-detail-actions { @apply flex flex-wrap items-end gap-2; }
.detail-status-select { @apply ml-auto flex flex-col gap-1; }
.detail-status-select select { @apply h-9; }
.needs-you-card { @apply rounded-xl border p-4; color: var(--text-primary); border-color: color-mix(in srgb, var(--border-strong) 60%, #d97706); background: color-mix(in srgb, var(--surface-elevated) 92%, #d97706); }
.needs-you-heading { @apply flex items-center gap-2; }
.needs-you-heading svg { @apply h-4 w-4; }
.needs-you-card > p { @apply my-2 text-sm leading-5; }
.needs-you-card form { @apply flex flex-col items-end gap-2; }
.detail-section { @apply border-t pt-4; border-color: var(--border-soft); }
.detail-section h3 { @apply m-0 text-sm font-semibold; }
.detail-section-title { @apply flex items-center justify-between; }
.detail-section-title > span { @apply text-xs; color: var(--text-muted); }
.detail-prewrap { @apply mt-2 mb-0 whitespace-pre-wrap text-sm leading-6; color: var(--text-secondary); }
.detail-muted { background: var(--surface-muted); @apply mt-2 rounded-lg px-3 py-3 text-sm; color: var(--text-muted); }
.task-list, .artifact-list, .run-list, .comment-list { @apply mt-2 list-none space-y-2 p-0; }
.task-list li { @apply flex gap-3 rounded-lg border p-3; border-color: var(--border-soft); }
.task-status-icon { @apply mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border; border-color: var(--border-strong); }
.task-status-icon svg { @apply h-3.5 w-3.5; }
.task-list li[data-task-status='done'] .task-status-icon { @apply border-emerald-500 bg-emerald-500 text-white; }
.task-list li[data-task-status='working'] .task-status-icon { @apply border-blue-500 text-blue-600; }
.task-list li[data-task-status='working'] .task-status-icon svg { @apply animate-spin; }
.task-list li > div { @apply min-w-0; }
.task-list strong, .artifact-list strong, .run-list strong, .comment-list strong { @apply text-sm font-medium; }
.task-list p, .run-list p, .comment-list p { @apply mt-0.5 mb-0 text-xs leading-5; color: var(--text-secondary); }
.task-list small { @apply mt-1 block text-[11px]; color: var(--text-muted); }
.artifact-list li, .run-list li { background: var(--surface-muted); @apply flex items-start gap-2 rounded-lg px-3 py-2; }
.artifact-list svg { @apply mt-0.5 h-4 w-4 shrink-0; color: var(--text-muted); }
.artifact-list span { @apply min-w-0; }
.artifact-list code { @apply mt-0.5 block break-all text-[11px]; color: var(--text-muted); }
.run-dot { @apply mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500; }
.run-dot[data-status='running'], .run-dot[data-status='queued'] { @apply bg-blue-500; }
.run-dot[data-status='succeeded'] { @apply bg-emerald-500; }
.comment-list li { background: var(--surface-muted); @apply rounded-lg px-3 py-2; }
.comment-form { @apply mt-2 flex gap-2; }
.board-detail-footer { @apply flex justify-end border-t px-5 py-3; border-color: var(--border-soft); }
.danger-button { @apply text-rose-600 hover:bg-rose-50 hover:text-rose-700; }
.board-dialog { @apply fixed top-1/2 left-1/2 z-[70] max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-xl border shadow-2xl outline-none; background: var(--surface-elevated); color: var(--text-primary); border-color: var(--border-soft); }
.board-dialog-small { @apply max-w-md; }
.board-dialog > header { @apply sticky top-0 z-10 flex items-start justify-between gap-4 border-b px-5 py-4; border-color: var(--border-soft); background: var(--surface-elevated); }
.board-dialog header :deep(h2) { @apply m-0 text-lg font-semibold; }
.board-dialog header p { @apply mt-1 mb-0 text-sm; color: var(--text-secondary); }
.board-form { @apply space-y-4 p-5; }
.board-form > label, .new-agent-form label { @apply flex flex-col gap-1.5; }
.board-form-grid { @apply grid grid-cols-2 gap-3; }
.board-form-grid label { @apply flex flex-col gap-1.5; }
.board-form footer { @apply flex justify-end gap-2 pt-2; }
.board-form .checkbox-row { @apply flex-row items-start gap-2; }
.checkbox-row input, .agent-row input { @apply h-4 w-4 accent-blue-600; }
.agent-dialog { @apply max-w-5xl; }
.agent-dialog > header { position: sticky; top: 0; z-index: 1; background: var(--surface-elevated); }
.agent-dialog-body { @apply grid grid-cols-[1fr_1.2fr] items-start gap-5 p-5; }
.agent-dialog-body > section, .new-agent-form { min-width: 0; }
.agent-search { @apply mb-3; }
.agent-dialog-body h3 { @apply mt-0 mb-3 text-sm font-semibold; }
.agent-row { @apply mb-2 grid grid-cols-[auto_auto_1fr_auto] items-start gap-3 rounded-lg border p-3; border-color: var(--border-soft); }
.agent-row input { @apply mt-2; }
.agent-avatar { background: var(--surface-muted); @apply flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold; }
.agent-row > label { @apply min-w-0; }
.agent-row strong { @apply block text-sm; }
.agent-row small { @apply block text-[11px]; color: var(--text-muted); }
.agent-row p { @apply mt-1 mb-0 text-xs; color: var(--text-secondary); }
.agent-row.is-editing { border-color: var(--text-muted); background: var(--surface-muted); }
.agent-help { @apply my-2 text-xs leading-5; color: var(--text-muted); }
:deep(.agent-instructions) { min-height: 14rem; field-sizing: fixed; }
.agent-draft-note { @apply text-xs; color: var(--text-secondary); }
.new-agent-form { scroll-margin-top: 8rem; background: var(--surface-muted); @apply space-y-3 rounded-xl p-4; }

.question-picker { @apply flex min-w-0 flex-col gap-1 text-xs; }
.question-picker select { @apply min-w-0 w-full; }
.verification-help { @apply m-0 text-xs leading-5; color: var(--text-secondary); }
.agent-access-note { @apply mx-5 mt-4 mb-0 text-sm leading-5; color: var(--text-secondary); }
select:disabled { cursor: not-allowed; opacity: 0.65; }
.lane-add:hover { background: var(--surface-hover); }

@media (min-width: 1280px) and (pointer: fine) {
  .board-panel-backdrop { @apply hidden; }
  .board-detail-panel { @apply pointer-events-auto; width: min(42rem, 44vw); }
}

@media (max-width: 700px) {
  .boards-hub { @apply overflow-y-auto px-2; }
  .boards-hub > * { flex-shrink: 0; }
  .boards-header { @apply py-2; }
  .boards-heading-copy p { @apply hidden; }
  .boards-header-actions { @apply w-full; }
  .boards-header-actions button { @apply flex-1; }
  .boards-header > .boards-header-actions { @apply grid grid-cols-2; }
  .boards-toolbar { @apply items-stretch; }
  .boards-toolbar label { @apply min-w-0 flex-1; }
  .boards-toolbar select { @apply w-full; }
  .boards-hub select, .board-detail-panel select, .board-dialog select { font-size: 16px; }
  .boards-hub :deep(button), .boards-hub select, .board-detail-panel :deep(button), .board-detail-panel select, .board-dialog :deep(button), .board-dialog select { min-height: 44px; }
  .boards-hub :deep(button), .board-detail-panel :deep(button), .board-dialog :deep(button) { min-width: 44px; }
  .board-card-main { @apply pb-14; }
  .board-card-move select { @apply text-xs; }
  .boards-toolbar .boards-auto-toggle { @apply ml-0 min-h-11 w-full flex-none pb-0; }
  .board-lane { @apply w-[85vw]; }
  .boards-lanes { flex: none; height: max(24rem, 60dvh); }
  .board-view-tabs { @apply mb-3; }
  .board-view-tabs button { @apply flex-1 justify-center; }
  .board-view-panel { flex: none; }
  .board-detail-panel { @apply max-w-none; }
  .board-form-grid, .agent-dialog-body { @apply grid-cols-1; }
  .board-dialog { @apply top-auto bottom-0 left-0 max-h-[94dvh] w-full translate-x-0 translate-y-0 rounded-b-none; }
  .board-detail-footer, .board-form { padding-bottom: max(1rem, env(safe-area-inset-bottom)); }
}
</style>
