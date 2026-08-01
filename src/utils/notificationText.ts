import markdownit from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

const markdown = markdownit({
  html: true,
  linkify: false,
  typographer: false,
  breaks: true,
})

const BLOCK_BOUNDARY_TYPES = new Set([
  'blockquote_close',
  'code_block',
  'fence',
  'heading_close',
  'hr',
  'list_item_close',
  'paragraph_close',
  'table_close',
  'td_close',
  'th_close',
  'tr_close',
])

function removeWritingBlockMarkers(value: string): string {
  let inWritingBlock = false
  const lines: string[] = []
  for (const line of value.split(/\r?\n/u)) {
    if (/^ {0,3}:::writing(?:\{.*)?\s*$/u.test(line)) {
      inWritingBlock = true
      continue
    }
    if (inWritingBlock && /^ {0,3}:::\s*$/u.test(line)) {
      inWritingBlock = false
      continue
    }
    lines.push(line)
  }
  return lines.join('\n')
}

function stripHtml(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
}

function stripCollapsedMarkdownArtifacts(value: string): string {
  return value
    .replace(/```(?:[a-z0-9_-]+)?/giu, ' ')
    .replace(/(^|\s)#{1,6}\s+(?=\S)/gu, '$1')
    .replace(/(^|\s)>\s+(?=\S)/gu, '$1')
    .replace(/(^|\s)(?:[-+*]|\d+[.)])\s+(?=\S)/gu, '$1')
    .replace(/\s*\|\s*/gu, ' ')
}

function appendTokenText(token: Token, fragments: string[]): void {
  if (token.type === 'inline' && token.children) {
    for (const child of token.children) appendTokenText(child, fragments)
    return
  }

  if (
    token.type === 'text' ||
    token.type === 'code_inline' ||
    token.type === 'code_block' ||
    token.type === 'fence' ||
    token.type === 'image'
  ) {
    fragments.push(token.content)
  } else if (token.type === 'html_inline' || token.type === 'html_block') {
    fragments.push(stripHtml(token.content))
  } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
    fragments.push(' ')
  }

  if (BLOCK_BOUNDARY_TYPES.has(token.type)) fragments.push(' ')
}

export function markdownToNotificationText(value: string): string {
  const source = removeWritingBlockMarkers(value).trim()
  if (!source) return ''

  const fragments: string[] = []
  for (const token of markdown.parse(source, {})) appendTokenText(token, fragments)
  return stripCollapsedMarkdownArtifacts(fragments.join('')).replace(/\s+/gu, ' ').trim()
}

export function compactNotificationText(
  value: string,
  fallback: string,
  maxLength = 180,
): string {
  const normalized = markdownToNotificationText(value)
  const resolved = normalized || fallback
  if (resolved.length <= maxLength) return resolved
  return `${resolved.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}
