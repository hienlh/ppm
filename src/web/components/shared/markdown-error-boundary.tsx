import { Component, type ReactNode } from "react";

interface Props {
  /** Plain text fallback when fallback ReactNode is not provided */
  fallbackContent?: string;
  /** Custom fallback ReactNode — takes precedence over fallbackContent */
  fallback?: ReactNode;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Error boundary that catches React DOM reconciliation errors
 * (e.g. "removeChild" failures from rehype-raw or browser extensions).
 * Falls back to provided content instead of crashing the whole app.
 */
export class RenderErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return this.props.fallbackContent ? (
        <div className="text-sm whitespace-pre-wrap break-words text-text-primary opacity-80">
          {this.props.fallbackContent}
        </div>
      ) : null;
    }
    return this.props.children;
  }
}
