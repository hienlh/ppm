import { Component, type ReactNode } from "react";

interface Props {
  fallbackContent?: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Error boundary that catches React DOM reconciliation errors
 * (e.g. "removeChild" failures from rehype-raw or browser extensions).
 * Falls back to plain text rendering instead of crashing the whole app.
 */
export class MarkdownErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      // Show raw text as fallback — still readable, just not formatted
      return this.props.fallbackContent ? (
        <div className="text-sm whitespace-pre-wrap break-words text-text-primary opacity-80">
          {this.props.fallbackContent}
        </div>
      ) : null;
    }
    return this.props.children;
  }
}
