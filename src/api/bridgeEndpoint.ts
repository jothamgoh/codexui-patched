import { CodexApiError, extractErrorMessage } from './codexErrors'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function callBridgeEndpoint<T>(
  path: string,
  body: unknown,
  method: string,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new CodexApiError(
      error instanceof Error ? error.message : `${method} failed before request was sent`,
      { code: 'network_error', method },
    )
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new CodexApiError(
      extractErrorMessage(payload, `${method} failed with HTTP ${response.status}`),
      { code: 'http_error', method, status: response.status },
    )
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (payload === null && contentType.includes('text/html')) {
    throw new CodexApiError(
      'This browser loaded a newer CodexUI frontend than the running server. Restart the CodexUI service, then try again.',
      { code: 'invalid_response', method, status: response.status },
    )
  }

  const envelope = asRecord(payload)
  if (!envelope || !('result' in envelope)) {
    throw new CodexApiError(`${method} returned a malformed envelope`, {
      code: 'invalid_response',
      method,
      status: response.status,
    })
  }
  return envelope.result as T
}
