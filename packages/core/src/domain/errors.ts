export type DomainErrorCode =
  | "not_found"
  | "ambiguous_id"
  | "no_candidates"
  | "not_configured"
  | "no_basis"
  | "resolved_requires_insight"
  | "probe_not_pending"
  | "insight_requires_source"
  | "link_not_proposed"
  | "already_recorded"
  | "invalid_input"
  | "bad_reply";

/** 违反领域规则时抛出；code 供调用方（命令行、查看器）分辨处理。 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function notFound(what: string, id: string): DomainError {
  return new DomainError("not_found", `${what} ${id} 不存在`);
}
