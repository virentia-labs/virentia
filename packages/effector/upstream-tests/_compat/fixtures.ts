export function argumentHistory(fn: any): unknown[] {
  return fn.mock.calls.map((call: unknown[]) => (call.length <= 1 ? call[0] : call));
}

export function muteErrors(): void {}
