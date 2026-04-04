export interface TeamInfo {
  name: string;
  description: string;
  createdAt: number;
  leadSessionId: string;
  memberCount: number;
  cwd?: string;
}

export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  model: string;
  joinedAt: number;
  status: "active" | "idle" | "shutdown";
}

export interface InboxMessage {
  from: string;
  to: string;
  text: string;
  timestamp: string;
  read: boolean;
  color?: string;
  summary?: string;
  parsedType?: "task_assignment" | "idle_notification" | "completion" | "shutdown_request" | "shutdown_approved" | "message";
}

export interface TeamDetail extends TeamInfo {
  members: TeamMember[];
  messages: InboxMessage[];
}
