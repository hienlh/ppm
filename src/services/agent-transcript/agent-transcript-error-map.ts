/**
 * Collapse the internal ownership/source error codes down to the four fixed
 * codes the wire protocol allows — nothing past this point ever carries an
 * internal enum name, a path, or an exception message.
 */
import type { OwnershipErrorCode } from "./session-ownership.ts";
import type { SourceErrorCode } from "./agent-transcript-sources.ts";
import type { AgentTranscriptErrorCode } from "../../shared/agent-transcript-protocol.ts";

export function mapOwnershipErrorCode(code: OwnershipErrorCode): AgentTranscriptErrorCode {
  switch (code) {
    case "invalid_session_id":
    case "invalid_provider":
      return "bad_request";
    case "invalid_project":
    case "session_not_found":
      return "not_found";
  }
}

export function mapSourceErrorCode(code: SourceErrorCode): AgentTranscriptErrorCode {
  switch (code) {
    case "invalid_card_id":
    case "invalid_team_name":
    case "invalid_member_name":
      return "bad_request";
    case "card_not_found":
    case "member_not_found":
      return "not_found";
    case "not_descendant":
      return "forbidden";
  }
}
