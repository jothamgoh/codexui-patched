import type { ReasoningEffort } from '../types/codex'
import type { ProjectBoardModelCatalog } from '../types/projectBoardModels'
import { readCodexUiRuntimeConfig } from './runtimeConfig'

const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const effort = (value: unknown): ReasoningEffort | '' => typeof value === 'string' && efforts.has(value) ? value as ReasoningEffort : ''

export async function readProjectBoardModels(rpc: (method: string, params: unknown) => Promise<unknown>): Promise<ProjectBoardModelCatalog> {
  const [listed, configured] = await Promise.all([
    rpc('model/list', { includeHidden: true }),
    rpc('config/read', {}),
  ])
  const rows = record(listed).data
  if (!Array.isArray(rows)) throw new Error('Could not load the available models. Try again.')
  const models = rows.map(record).map((row) => ({
    id: text(row.model) || text(row.id),
    label: text(row.displayName) || text(row.model) || text(row.id),
    reasoningEfforts: (Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [])
      .map((option) => effort(record(option).reasoningEffort)).filter((value): value is ReasoningEffort => Boolean(value)),
    defaultReasoningEffort: effort(row.defaultReasoningEffort) || 'medium' as ReasoningEffort,
  })).filter((model) => model.id)
  const config = record(record(configured).config)
  const defaultRow = rows.map(record).find((row) => row.isDefault === true)
  const defaultModel = text(config.model) || text(defaultRow?.model) || text(defaultRow?.id) || models[0]?.id || ''
  const defaultReasoningEffort = effort(readCodexUiRuntimeConfig().defaultReasoningEffort)
    || effort(config.model_reasoning_effort)
    || models.find((model) => model.id === defaultModel)?.defaultReasoningEffort || 'medium'
  return { models, defaultModel, defaultReasoningEffort }
}

export function resolveProjectBoardExecutionSettings(catalog: ProjectBoardModelCatalog, requested: { model: string; reasoningEffort: ReasoningEffort }): { model: string; reasoningEffort: ReasoningEffort } {
  const modelId = requested.model || catalog.defaultModel
  const model = catalog.models.find((entry) => entry.id === modelId)
  if (!model) throw new Error(`Model “${modelId || 'default'}” is unavailable. Choose an available model in the feature settings.`)
  const reasoningEffort = requested.reasoningEffort || catalog.defaultReasoningEffort
  if (model.reasoningEfforts.length > 0 && !model.reasoningEfforts.includes(reasoningEffort)) {
    throw new Error(`“${model.label}” does not support ${reasoningEffort} reasoning. Choose a supported reasoning level.`)
  }
  return { model: modelId, reasoningEffort }
}
