export type RpcEnvelope<T> = {
  result: T
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export type RpcMethodCatalog = {
  data: string[]
}

export type ThreadListResult = {
  data: ThreadSummary[]
  nextCursor?: string | null
}

export type ThreadSummary = {
  id: string
  preview: string
  title?: string
  name?: string
  cwd: string
  updatedAt: number
  createdAt: number
  source?: unknown
}

export type ThreadReadResult = {
  thread: ThreadDetail
}

export type ThreadDetail = {
  id: string
  cwd: string
  preview: string
  turns: ThreadTurn[]
  updatedAt: number
  createdAt: number
}

export type ThreadTurn = {
  id: string
  status: string
  items: ThreadItem[]
}

export type ThreadItem = {
  id: string
  type: string
  text?: string
  content?: unknown
  summary?: string[]
}

export type UserInput = {
  type: string
  text?: string
  path?: string
  url?: string
}

export type UiThread = {
  id: string
  title: string
  projectName: string
  cwd: string
  hasWorktree: boolean
  createdAtIso: string
  updatedAtIso: string
  preview: string
  runtimeStatus?: 'active' | 'idle' | 'notLoaded' | 'systemError'
  unread: boolean
  inProgress: boolean
}

export type CommandExecutionData = {
  command: string
  cwd: string | null
  status: 'inProgress' | 'completed' | 'failed' | 'declined' | 'interrupted'
  aggregatedOutput: string
  exitCode: number | null
}

export type ToolCallData = {
  kind: 'mcp' | 'collab' | 'web'
  label: string
  detail: string
  status: 'inProgress' | 'completed' | 'failed'
  progress: string
  description?: string
  statusLabel?: string
  tone?: 'neutral' | 'warning' | 'error'
}

export type McpAppResultData = {
  server: string
  tool: string
  appName: string
  resourceUri: string
  toolInput: unknown
  structuredContent: unknown
  resultMeta: unknown
}

export type ThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'

export type UiThreadGoal = {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export type UiTokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type UiThreadTokenUsage = {
  threadId: string
  turnId: string
  total: UiTokenUsageBreakdown
  last: UiTokenUsageBreakdown
  modelContextWindow: number | null
}

export type UiFileAttachment = { label: string; path: string }

export type UiThreadReference = {
  id: string
  name: string
  path: string
}

export type ResponseTextAnnotation = {
  id: string
  text: string
  annotation?: string
  sourceMessageId?: string
}

export type ReviewChangeKind = 'add' | 'delete' | 'update'

export type ReviewPatchChange = {
  path: string
  kind: ReviewChangeKind
  movePath?: string
  diff: string
}

export type ReviewPatchBatch = {
  id: string
  cwd: string
  fingerprint: string
  byteLength: number
  patch?: string
}

export type ReviewDiffLineKind = 'context' | 'added' | 'removed' | 'meta'

export type ReviewDiffLine = {
  id: string
  kind: ReviewDiffLineKind
  marker: ' ' | '+' | '-' | ''
  text: string
  oldLine: number | null
  newLine: number | null
}

export type ReviewDiffFile = {
  path: string
  previousPath?: string
  kind: ReviewChangeKind
  additions: number
  deletions: number
  lines: ReviewDiffLine[]
  totalLines: number
  isTruncated: boolean
}

export type ReviewChangesData = {
  files: ReviewDiffFile[]
  fileCount: number
  changeCount: number
  filesTruncated: boolean
  additions: number
  deletions: number
  patchBatches: ReviewPatchBatch[]
  actionUnavailableReason?: string
}

export type GitWorkspaceReviewSource = 'uncommitted' | 'unstaged' | 'staged' | 'branch'

export type GitWorkspaceBranch = {
  name: string
  ref: string
  current: boolean
  upstream?: string
}

export type GitWorkspaceBaseBranch = {
  name: string
  ref: string
  remote: boolean
}

export type GitWorkspaceCounts = {
  total: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

export type GitWorkspaceStatus = {
  cwd: string
  root: string
  currentBranch: string | null
  detachedHead: string | null
  branches: GitWorkspaceBranch[]
  baseBranches: GitWorkspaceBaseBranch[]
  defaultBaseBranch: string | null
  branchesTruncated: boolean
  counts: GitWorkspaceCounts
  countsTruncated: boolean
  isDirty: boolean
}

export type GitWorkspaceReview = {
  source: GitWorkspaceReviewSource
  baseBranch?: GitWorkspaceBaseBranch
  changes: ReviewChangesData | null
  omittedUntrackedFiles: number
  untrackedFilesTruncated: boolean
}

export type GitWorkspaceSwitchErrorCode =
  | 'branch_not_found'
  | 'local_changes'
  | 'conflicts'
  | 'branch_in_use'
  | 'repository_operation_in_progress'
  | 'checkout_filters'
  | 'checkout_interrupted'
  | 'git_error'

export type GitWorkspaceSwitchResult = {
  status: 'success' | 'blocked' | 'failed'
  branch: string
  previousBranch: string | null
  currentBranch: string | null
  error?: string
  details?: {
    code: GitWorkspaceSwitchErrorCode
    paths?: string[]
  }
}

export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  images?: string[]
  fileAttachments?: UiFileAttachment[]
  threadReferences?: UiThreadReference[]
  responseAnnotations?: ResponseTextAnnotation[]
  orderKey?: string
  messageType?: string
  rawPayload?: string
  isUnhandled?: boolean
  commandExecution?: CommandExecutionData
  toolCall?: ToolCallData
  mcpApp?: McpAppResultData
  reviewChanges?: ReviewChangesData
  turnId?: string
  turnIndex?: number
}

export type UiServerRequest = {
  id: number
  method: string
  threadId: string
  turnId: string
  itemId: string
  receivedAtIso: string
  params: unknown
}

export type UiServerRequestReply = {
  id: number
  result?: unknown
  error?: {
    code?: number
    message: string
  }
}

export type UiLiveOverlay = {
  activityLabel: string
  activityDetails: string[]
  reasoningText: string
  errorText: string
}

export type UiProjectGroup = {
  projectName: string
  threads: UiThread[]
}

export type ThreadScrollState = {
  scrollTop: number
  isAtBottom: boolean
  scrollRatio?: number
}

export type ChatMessage = {
  id: string
  role: string
  text: string
  createdAt: string | null
}

export type ChatThread = {
  id: string
  title: string
  projectName: string
  updatedAt: string | null
  messages: ChatMessage[]
}
