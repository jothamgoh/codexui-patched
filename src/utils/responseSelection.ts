export type ResponseSelectionPointerType = '' | 'mouse' | 'pen' | 'touch'
export type ResponseSelectionPointerDownAction =
  | 'ignore'
  | 'close-editor'
  | 'track-selection'
  | 'dismiss-selection'
  | 'none'

export const TOUCH_SELECTION_SETTLE_MS = 140

export function normalizeResponseSelectionPointerType(pointerType: string): ResponseSelectionPointerType {
  if (pointerType === 'touch' || pointerType === 'pen' || pointerType === 'mouse') return pointerType
  return ''
}

export function shouldUseDockedResponseSelectionActions(
  hasCoarsePointer: boolean,
  pointerType: ResponseSelectionPointerType,
): boolean {
  return hasCoarsePointer || pointerType === 'touch' || pointerType === 'pen'
}

export function responseSelectionPointerDownAction(options: {
  isInteractiveTarget: boolean
  hasAnnotationEditor: boolean
  isResponseSurface: boolean
  hasCapturedSelection: boolean
}): ResponseSelectionPointerDownAction {
  if (options.isInteractiveTarget) return 'ignore'
  if (options.hasAnnotationEditor) return 'close-editor'
  if (options.isResponseSurface) return 'track-selection'
  if (options.hasCapturedSelection) return 'dismiss-selection'
  return 'none'
}

export function shouldCaptureResponseSelectionAfterPointerUp(
  selectionChangedWhilePointerDown: boolean,
): boolean {
  // A plain tap on an existing browser selection must dismiss the action UI.
  // Re-capture only when the browser reports that the range actually changed.
  return selectionChangedWhilePointerDown
}

export function responseSelectionSettleDelay(
  useDockedActions: boolean,
): number {
  return useDockedActions ? TOUCH_SELECTION_SETTLE_MS : 0
}

export function responseAnnotationPositionUpdateStrategy(
  useDockedActions: boolean,
): 'always' | 'optimized' {
  return useDockedActions ? 'always' : 'optimized'
}
