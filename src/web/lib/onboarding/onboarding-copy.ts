import type { OnboardingFamiliarity, OnboardingStepId } from "./onboarding-types";

interface StepCopy { title: string; body: string; more: string; action: string }
const copy: Record<OnboardingStepId, { title: string; action: string; bodies: [string, string, string]; more: string }> = {
  project: {
    title: "Choose a project", action: "Choose project",
    bodies: ["A project is a folder with the files you want to work on. Choose one on the computer running PPM, which may be different from your phone.", "Choose or add a project to begin.", "Select the workspace for this walkthrough."],
    more: "Use the project picker to select an existing folder or add one. The tour never creates files or changes your project.",
  },
  chat: {
    title: "Open AI chat", action: "Open chat",
    bodies: ["Chat lets you ask an AI assistant about your project. Open a chat and choose an available AI provider.", "Open a chat with your preferred available provider.", "Open a provider-backed chat tab."],
    more: "If no provider is ready, use the existing setup or retry controls, or open AI Settings. You can pause this guide and return after setup.",
  },
  send: {
    title: "Ask about your project", action: "Use suggested question",
    bodies: ["Ask AI to explain your project. You can use our suggested question or write your own, then press Send yourself.", "Send a question and wait for a successful answer.", "Complete one AI turn in this project."],
    more: "The suggestion requests reading only; your provider's existing permissions still apply. Your draft is never replaced and nothing is sent automatically. Errors or interrupted replies do not complete this step.",
  },
  history: {
    title: "Find your conversation", action: "Show conversation history",
    bodies: ["Use the chat history menu to open the conversation you just had. This is how you return to your work later.", "Reopen this conversation from the chat history menu.", "Select the completed session in chat history."],
    more: "Choose the conversation from the history menu above the chat, even if it is already open. If you skipped sending a message, you can skip this step too.",
  },
  file: {
    title: "Read a project file", action: "Open files",
    bodies: ["The file explorer shows your project's folders and files. Open any text file that you want to read.", "Open any text file from the explorer.", "Open any source, text or Markdown file."],
    more: "This step completes when a text editor or Markdown Preview loads successfully. The filename does not matter. Images and databases are not part of this reading exercise. If the project is empty or has no readable files, skip this step or choose another project; no sample file is created automatically.",
  },
  search: {
    title: "Search your project", action: "Open search",
    bodies: ["Search helps you find words inside project files. Type at least two characters and look at the results.", "Search file contents using at least two characters.", "Run a project content search."],
    more: "A successful search with no matches still counts. A failed request does not. Try a different word, retry an error, or open a result to read its file.",
  },
  terminal: {
    title: "Open the terminal", action: "Open terminal",
    bodies: ["A terminal runs commands on the computer hosting PPM. Open one and wait for it to connect; you do not need to type a command yet.", "Open a terminal and wait for the shell to become ready.", "Connect a terminal for this project."],
    more: "The tour never types or executes commands. If connection fails, retry using the terminal controls or skip this step.",
  },
  git: {
    title: "View project changes", action: "Open Git changes",
    bodies: ["Git tracks changes in a project. Open its changes view to see whether files have changed.", "Inspect the project's Git status.", "Load the working-tree status."],
    more: "A clean repository counts too. If the folder does not use Git, skip this step or choose another project. The tour never initializes a repository or commits changes.",
  },
  run: {
    title: "Find how to run the project", action: "Find run instructions",
    bodies: ["Open README or a package manifest and look for instructions to start the project. You can use those instructions in the terminal when you are ready.", "Find the documented run instructions in README or a package manifest.", "Inspect README or package scripts for the run command."],
    more: "Find run instructions opens a README in the project root, or package.json if there is no readable README. README Preview counts too. After reading, confirm that you know where to find the instructions. This does not run the project. If no file is found, browse Files or skip this step.",
  },
};

export const ONBOARDING_SUGGESTED_PROMPT = "Summarize this project and explain how to run it. Only read; do not edit files.";
export function getOnboardingCopy(step: OnboardingStepId, familiarity: OnboardingFamiliarity | null): StepCopy {
  const item = copy[step];
  const index = familiarity === "advanced" ? 2 : familiarity === "familiar" ? 1 : 0;
  return { title: item.title, body: item.bodies[index], more: item.more, action: item.action };
}
