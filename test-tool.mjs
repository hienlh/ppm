import { ClaudeAgentSdkProvider } from "./src/providers/claude-agent-sdk.ts";

// Remove CLAUDECODE to avoid nested session error
delete process.env.CLAUDECODE;

const projectPath = process.argv[2] || "/tmp";
const prompt = process.argv[3] || "Run bash: echo TOOL_TEST_OK";

console.log(`Testing tools with projectPath: ${projectPath}`);
console.log(`Prompt: ${prompt}\n`);

const provider = new ClaudeAgentSdkProvider();
const session = await provider.createSession({
  title: "Tool Test",
  projectPath,
});

console.log(`Session: ${session.id}\n`);

for await (const event of provider.sendMessage(session.id, prompt)) {
  switch (event.type) {
    case "text":
      console.log(`  TEXT: ${event.content?.slice(0, 120)}`);
      break;
    case "tool_use":
      console.log(`✓ TOOL_USE: ${event.tool}`, JSON.stringify(event.input).slice(0, 80));
      break;
    case "tool_result":
      console.log(`  RESULT: ${event.output?.slice(0, 120)}`);
      break;
    case "error":
      console.log(`✗ ERROR: ${event.message}`);
      break;
    case "usage":
      console.log(`  USAGE:`, JSON.stringify(event.usage));
      break;
    case "done":
      console.log(`\nDone (session: ${event.sessionId})`);
      break;
  }
}
