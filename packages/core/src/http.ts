/** fetch 失败时真正的原因藏在 cause 里（DNS、连接被拒、超时等）。 */
export function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : e.cause ? String(e.cause) : "";
  return cause ? `${e.message}（${cause}）` : e.message;
}
