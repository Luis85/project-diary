/** Keep unknown filesystem/network failures typed without assuming their shape. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Add useful operation context while preserving the original failure for callers. */
export function contextualError(context: string, error: unknown): Error {
  return new Error(`${context}: ${errorMessage(error)}`, { cause: error });
}

/** Untrusted identifiers must stay bounded and on one visible log line. */
export function diagnosticLabel(value: string): string {
  const visible = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '\uFFFD');
  return JSON.stringify(visible.length > 160 ? `${visible.slice(0, 160)}…` : visible);
}
