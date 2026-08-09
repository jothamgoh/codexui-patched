type ComposerDeviceNavigator = Pick<Navigator, 'maxTouchPoints' | 'platform' | 'userAgent'>

export function shouldDismissComposerKeyboardAfterSubmit(
  navigatorLike: ComposerDeviceNavigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): boolean {
  if (!navigatorLike) return false

  return /Android|iP(?:ad|hone|od)/i.test(navigatorLike.userAgent)
    || (navigatorLike.platform === 'MacIntel' && navigatorLike.maxTouchPoints > 1)
}

export function settleComposerFocusAfterSubmit(
  input: Pick<HTMLTextAreaElement, 'blur' | 'focus'> | null,
  navigatorLike?: ComposerDeviceNavigator,
): void {
  if (!input) return
  if (shouldDismissComposerKeyboardAfterSubmit(navigatorLike)) input.blur()
  else input.focus()
}
