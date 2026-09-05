import type { ReasoningEffort } from './codex'

export type ProjectBoardModel = {
  id: string
  label: string
  reasoningEfforts: ReasoningEffort[]
  defaultReasoningEffort: ReasoningEffort
}

export type ProjectBoardModelCatalog = {
  models: ProjectBoardModel[]
  defaultModel: string
  defaultReasoningEffort: ReasoningEffort
}
