export type ComposerKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'
>

export function shouldSubmitComposerWithCommandEnter(event: ComposerKeyEvent): boolean {
  return event.key === 'Enter'
    && event.metaKey
    && !event.altKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.isComposing
}
