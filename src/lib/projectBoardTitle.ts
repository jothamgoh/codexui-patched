/** A useful local fallback while the user starts from a brief, without a model call. */
export function projectBoardTitleFromBrief(brief: string): string {
  const title = brief.split(/\r?\n/u)
    .map((line) => line.trim()
      .replace(/^(?:`{3,}|~{3,}).*$/u, '')
      .replace(/^(?:(?:#{1,6}|>|[-+*]|\d+[.)])\s+)+/u, '')
      .replace(/^\[[ xX]\]\s*/u, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/<((?:https?:\/\/)[^>]+)>/gu, '$1')
      .replace(/[`*]/gu, '')
      .replace(/(^|\s)_{1,2}(.+?)_{1,2}(?=\s|$|[.,;:!?])/gu, '$1$2')
      .replace(/~~(.+?)~~/gu, '$1')
      .replace(/\s+/gu, ' ')
      .trim())
    .find((line) => /[\p{L}\p{N}\p{S}]/u.test(line)) ?? ''
  const characters = Array.from(title)
  if (characters.length <= 80) return title
  const excerpt = characters.slice(0, 79).join('')
  const lastSpace = excerpt.lastIndexOf(' ')
  return `${(lastSpace > excerpt.length * 0.6 ? excerpt.slice(0, lastSpace) : excerpt).trimEnd()}…`
}
