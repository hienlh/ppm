/**
 * The PPM Assistant's rail icon: a small robot whose parts move on their own, so it reads as
 * someone at work rather than a glyph. Its mood follows the Assistant:
 *  - idle: breathes, blinks at uneven intervals, now and then glances aside, and its antenna sways;
 *  - thinking (the main session is running a turn): its eyes dart and the antenna light pulses;
 *  - waiting (cards wait on the user): it hops and looks up, eyes wide;
 *  - happy (its window is open): eyes squint into a smile.
 * Hovering the button makes it tilt its head. Every motion stops under `prefers-reduced-motion`.
 *
 * Drawn on the 20px grid the Fluent product icons use, so it sits beside them at the same weight.
 * The animation lives in `assistant-bot-icon.css`; this file only decides the mood.
 */
import { cn } from "@/lib/utils";
import { useAssistantMainSession } from "@/hooks/use-assistant-main-session";
import { useAssistantWaitingStore } from "@/stores/assistant-waiting-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useAssistantWindowShown } from "./use-assistant-window-shown";
import { assistantBotMood } from "@/lib/assistant-bot-mood";
import "./assistant-bot-icon.css";

export function AssistantBotIcon({ className }: { className?: string }) {
  const waiting = useAssistantWaitingStore((s) => s.total);
  const mainId = useAssistantMainSession().sessionId;
  const thinking = useStreamingStore((s) => !!mainId && s.sessions.has(mainId));
  const shown = useAssistantWindowShown();
  const mood = assistantBotMood({ waiting, thinking, shown });

  return (
    <svg
      viewBox="0 0 20 20"
      className={cn("ppm-bot", className)}
      data-mood={mood}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className="ppm-bot__body">
        <g className="ppm-bot__antenna">
          <path d="M10 5.2V3.3" />
          <circle className="ppm-bot__light" cx="10" cy="2.4" r="1.05" fill="currentColor" stroke="none" />
        </g>
        <path d="M2.7 9.3v2.4M17.3 9.3v2.4" />
        <g className="ppm-bot__head">
          <rect x="4.3" y="5.2" width="11.4" height="9.8" rx="3" />
          <g className="ppm-bot__eyes">
            <ellipse className="ppm-bot__eye" cx="7.9" cy="9.9" rx="1.05" ry="1.3" fill="currentColor" stroke="none" />
            <ellipse className="ppm-bot__eye" cx="12.1" cy="9.9" rx="1.05" ry="1.3" fill="currentColor" stroke="none" />
          </g>
          <path className="ppm-bot__mouth" d="M8.6 12.6q1.4 0.8 2.8 0" />
        </g>
        <path d="M7.4 17.4h5.2" />
      </g>
    </svg>
  );
}
