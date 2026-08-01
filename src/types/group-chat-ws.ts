import type { GroupMessage, GroupStatus, MemberStatus, BurstEndReason } from "./group-chat.ts";

/** Server → client group-chat WS events. */
export type GroupChatServerMessage =
  | { type: "group_state"; groupId: string; status: GroupStatus; members: Array<{ id: string; name: string; role: string; status: MemberStatus; color: string | null }> }
  | { type: "group_message"; message: GroupMessage }
  | { type: "member_status"; memberId: string; status: MemberStatus }
  | { type: "typing"; member: string }
  | { type: "turn_done"; turnIndex: number }
  | { type: "group_done"; reason: BurstEndReason; turns: number; costUsd: number }
  | { type: "error"; message: string }
  | { type: "ping" };

/** Client → server group-chat WS messages. */
export type GroupChatClientMessage =
  | { type: "message"; content: string }
  | { type: "stop" }
  | { type: "ready" };
