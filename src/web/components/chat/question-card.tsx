import { Fragment, useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from "react";
import type { AnswersById, NormalizedQuestion, QuestionOption } from "../../../shared/approval-questions";
import { QuestionOptionPreview, hasOptionPreviews, previewOptionIndex } from "./question-option-preview";
import { QuestionOptionTile, QuestionOtherRow, QuestionTabStrip, questionFrameClass, questionInputClass } from "./question-form-parts";

/* ── Types ── */
// One shape for Claude's and Codex's questions; the answer goes back by question id and the
// server turns it into what the asking provider expects. An option may carry a `preview`.
export type Question = NormalizedQuestion;
export type { QuestionOption };

interface QuestionCardProps {
  questions: Question[];
  onSubmit: (answersById: AnswersById) => void;
  onSkip: () => void;
  autoFocus?: boolean;
  /**
   * Draws the typed-answer field with more around it (a card mirroring the question adds a mic):
   * given the field, what is typed in it, how to replace that, and how to answer with it at once.
   */
  otherField?: (field: OtherFieldParts) => ReactNode;
}

export interface OtherFieldParts {
  input: ReactNode;
  typed: string;
  setTyped: (text: string) => void;
  /** Puts `text` in the field and submits, when every other question already has its answer. */
  submitWith: (text: string) => void;
}

/* ── Hook: form state ── */
function useQuestionForm(questions: Question[]) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [activeTab, setActiveTab] = useState(0);

  const handleSingleSelect = useCallback((qi: number, label: string) => {
    setAnswers((p) => ({ ...p, [qi]: [label] }));
    setCustomInputs((p) => ({ ...p, [qi]: "" }));
  }, []);

  const handleMultiSelect = useCallback((qi: number, label: string) => {
    setAnswers((p) => {
      const cur = p[qi] || [];
      return { ...p, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });
  }, []);

  const handleCustomInput = useCallback((qi: number, value: string) => {
    setCustomInputs((p) => ({ ...p, [qi]: value }));
    if (value) setAnswers((p) => ({ ...p, [qi]: [] }));
  }, []);

  const hasAnswer = useCallback(
    (qi: number) => (answers[qi]?.length ?? 0) > 0 || (customInputs[qi]?.trim().length ?? 0) > 0,
    [answers, customInputs],
  );

  const allAnswered = useMemo(() => questions.every((_, i) => hasAnswer(i)), [questions, hasAnswer]);

  const getFinalAnswer = useCallback(
    (qi: number): string[] => {
      const custom = customInputs[qi]?.trim();
      if (custom) return [custom];
      return answers[qi] ?? [];
    },
    [answers, customInputs],
  );

  const goToNextTab = useCallback(() => setActiveTab((p) => Math.min(p + 1, questions.length - 1)), [questions.length]);
  const goToPrevTab = useCallback(() => setActiveTab((p) => Math.max(p - 1, 0)), []);

  return {
    answers, customInputs, activeTab, setActiveTab,
    handleSingleSelect, handleMultiSelect, handleCustomInput,
    hasAnswer, allAnswered, getFinalAnswer, goToNextTab, goToPrevTab,
  };
}

/* ── Hook: keyboard navigation ── */
function useQuestionKeyboard(config: {
  questions: Question[];
  activeTab: number;
  /** Rows the arrows move over: the options, plus the typed-answer row when there is one. */
  totalOptions: number;
  /** Listed options only (the number keys pick among these). */
  optionCount: number;
  hasCustom: boolean;
  allAnswered: boolean;
  hasAnswer: (i: number) => boolean;
  onSelectOption: (i: number) => void;
  goToNextTab: () => void;
  goToPrevTab: () => void;
  onSubmit: () => void;
  customInputRef: React.RefObject<HTMLInputElement | null>;
  enabled: boolean;
  autoFocus: boolean;
}) {
  const [focusedOption, setFocusedOption] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setFocusedOption(0), [config.activeTab]);

  useEffect(() => {
    if (!config.enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Resolve focus from the input's OWN document: this card can be rendered inside a
      // picture-in-picture window, and the module-global `document` is always the main one —
      // there the input is never active, so every printable key would be treated as a shortcut.
      const input = config.customInputRef.current;
      const isTyping = !!input && input.ownerDocument.activeElement === input;

      // Number keys 1-9
      if (!isTyping && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < config.optionCount) { setFocusedOption(idx); config.onSelectOption(idx); }
        return;
      }
      // O/0 → focus custom input
      if (!isTyping && config.hasCustom && (e.key === "o" || e.key === "O" || e.key === "0")) {
        e.preventDefault();
        config.customInputRef.current?.focus();
        setFocusedOption(config.totalOptions - 1);
        return;
      }
      // Tab between questions
      if (e.key === "Tab" && config.questions.length > 1) {
        e.preventDefault();
        e.shiftKey ? config.goToPrevTab() : config.goToNextTab();
        return;
      }
      if (!isTyping) {
        if (e.key === "ArrowLeft") { e.preventDefault(); config.goToPrevTab(); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); config.goToNextTab(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setFocusedOption((p) => Math.max(0, p - 1)); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); setFocusedOption((p) => Math.min(config.totalOptions - 1, p + 1)); return; }
        if (e.key === " ") { e.preventDefault(); config.onSelectOption(focusedOption); return; }
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (config.allAnswered) config.onSubmit();
        else if (config.hasAnswer(config.activeTab)) config.goToNextTab();
        return;
      }
      if (e.key === "Escape" && isTyping) { config.customInputRef.current?.blur(); }
    };

    const el = containerRef.current;
    if (el) {
      el.addEventListener("keydown", handleKeyDown);
      el.setAttribute("tabindex", "0");
    }
    return () => { el?.removeEventListener("keydown", handleKeyDown); };
  }, [config, focusedOption]);

  // Focus the card once, when it appears. Doing it on every render took focus back whenever the
  // card re-rendered for any reason, so with two chats side by side each waiting on a question,
  // the other card's chat updating pulled focus out of the card being answered. The owner
  // document is asked rather than the global one, for a card rendered in a picture-in-picture window.
  const autoFocusOnMount = useRef(config.autoFocus);
  useEffect(() => {
    const el = containerRef.current;
    if (autoFocusOnMount.current && el && !el.contains(el.ownerDocument.activeElement)) el.focus();
  }, []);

  return { focusedOption, setFocusedOption, containerRef };
}

/* ── Component ── */
export function QuestionCard({ questions, onSubmit, onSkip, autoFocus = true, otherField }: QuestionCardProps) {
  const customInputRef = useRef<HTMLInputElement>(null);
  const form = useQuestionForm(questions);
  const currentQ = questions[form.activeTab];
  const optionCount = currentQ?.options.length ?? 0;
  // A question that takes no typed answer (a Codex choice without "other") has no typed row.
  const hasCustom = !!currentQ?.allowsFreeText;
  const totalOptions = optionCount + (hasCustom ? 1 : 0);
  const hasMultiple = questions.length > 1;
  const hasPreview = !!currentQ && hasOptionPreviews(currentQ.options);

  const handleSubmit = useCallback(() => {
    if (!form.allAnswered) return;
    const result: AnswersById = {};
    questions.forEach((q, i) => { result[q.id] = form.getFinalAnswer(i); });
    onSubmit(result);
  }, [form.allAnswered, form.getFinalAnswer, questions, onSubmit]);

  const submitWith = useCallback((text: string) => {
    const tab = form.activeTab;
    form.handleCustomInput(tab, text);
    const result: AnswersById = {};
    questions.forEach((q, i) => { result[q.id] = i === tab ? [text.trim()] : form.getFinalAnswer(i); });
    if (Object.values(result).every((a) => a.length > 0 && a.some((x) => x.trim()))) onSubmit(result);
  }, [form, questions, onSubmit]);

  const handleSelectOption = useCallback(
    (index: number) => {
      if (!currentQ || index < 0) return;
      if (index < currentQ.options.length) {
        const label = currentQ.options[index]?.label;
        if (!label) return;
        if (currentQ.multiSelect) form.handleMultiSelect(form.activeTab, label);
        else form.handleSingleSelect(form.activeTab, label);
      } else if (index === currentQ.options.length && currentQ.allowsFreeText) {
        customInputRef.current?.focus();
      }
    },
    [currentQ, form],
  );

  const kb = useQuestionKeyboard({
    questions, activeTab: form.activeTab, totalOptions, optionCount, hasCustom,
    allAnswered: form.allAnswered, hasAnswer: form.hasAnswer,
    onSelectOption: handleSelectOption,
    goToNextTab: form.goToNextTab, goToPrevTab: form.goToPrevTab,
    onSubmit: handleSubmit, customInputRef, enabled: true, autoFocus,
  });

  const selectWithFocus = useCallback(
    (index: number) => { handleSelectOption(index); kb.setFocusedOption(index); },
    [handleSelectOption, kb.setFocusedOption],
  );

  return (
    <div
      ref={kb.containerRef}
      className={`${questionFrameClass("question")} animate-in slide-in-from-bottom-2`}
      data-question-card=""
    >
      {/* Header */}
      <div className="flex items-center justify-between text-sm font-medium text-text-primary">
        <span>
          AI has {hasMultiple ? `${questions.length} questions` : "a question"}
        </span>
        <span className="text-[10px] text-text-secondary font-normal">
          {hasMultiple ? "←→ tabs · " : ""}{optionCount > 0 ? `↑↓ options · 1-${Math.min(optionCount, 9)} select · ` : ""}Enter submit
        </span>
      </div>

      {/* Tabs */}
      {hasMultiple && (
        <QuestionTabStrip
          tone="question"
          active={form.activeTab}
          onSelect={(i) => { form.setActiveTab(i); kb.setFocusedOption(0); }}
          tabs={questions.map((q, i) => ({
            key: String(i),
            answered: form.hasAnswer(i),
            mark: form.hasAnswer(i) ? "✓" : i + 1,
            label: <span className="max-w-[100px] overflow-hidden text-ellipsis">{q.header || `Q${i + 1}`}</span>,
          }))}
        />
      )}

      {/* Current question */}
      {currentQ && (
        <div className="space-y-2">
          {!hasMultiple && currentQ.header && (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{currentQ.header}</div>
          )}
          <div className="text-sm text-text-primary select-text">{currentQ.question}</div>
          {currentQ.multiSelect && <div className="text-[11px] text-text-secondary">Select multiple</div>}

          {/* Options, with the preview pane beside them on a wide card and below them on a narrow one.
              Sized on the card's own width, not the viewport: a chat in a split pane is narrow on a desktop. */}
          <div className={hasPreview ? "@container" : undefined}>
          <div className={hasPreview ? "flex flex-col gap-2 @2xl:flex-row @2xl:items-start" : undefined}>
          <div className={`flex flex-col gap-1.5 ${hasPreview ? "@2xl:w-2/5 @2xl:shrink-0" : ""}`}>
            {currentQ.options.map((opt, oi) => (
              <QuestionOptionTile
                key={oi}
                index={oi}
                tone="question"
                label={opt.label}
                description={opt.description}
                selected={(form.answers[form.activeTab] || []).includes(opt.label)}
                focused={kb.focusedOption === oi}
                onSelect={() => selectWithFocus(oi)}
              />
            ))}

            {/* Other / custom input */}
            {hasCustom && (
              <QuestionOtherRow tone="question" focused={kb.focusedOption === totalOptions - 1}>
                {(() => { const input = (
                <input
                  ref={customInputRef}
                  // A secret (a token Codex asks for) is typed unseen, like any password field.
                  type={currentQ.secret ? "password" : "text"}
                  autoComplete="off"
                  className={questionInputClass("question")}
                  placeholder={optionCount > 0 ? "Other (press O to type)..." : "Type your answer..."}
                  value={form.customInputs[form.activeTab] || ""}
                  onChange={(e) => form.handleCustomInput(form.activeTab, e.target.value)}
                  onFocus={() => kb.setFocusedOption(totalOptions - 1)}
                />
                );
                // A secret is never spoken aloud, nor sent through a recording.
                if (!otherField || currentQ.secret) return input;
                const typed = form.customInputs[form.activeTab] || "";
                const tab = form.activeTab;
                return <Fragment key={tab}>{otherField({ input, typed, setTyped: (t) => form.handleCustomInput(tab, t), submitWith })}</Fragment>;
                })()}
              </QuestionOtherRow>
            )}
          </div>
          {hasPreview && (
            <div className="@2xl:flex-1 @2xl:min-w-0">
              <QuestionOptionPreview
                option={currentQ.options[previewOptionIndex(currentQ.options, kb.focusedOption, form.answers[form.activeTab] ?? [])]}
              />
            </div>
          )}
          </div>
          </div>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-2 justify-end pt-1">
        {hasMultiple && (
          <>
            <button
              className="px-3 py-1.5 text-xs rounded border border-border bg-background text-text-primary hover:bg-surface-elevated disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              onClick={form.goToPrevTab}
              disabled={form.activeTab === 0}
              tabIndex={-1}
            >
              ← Prev
            </button>
            <button
              className="px-3 py-1.5 text-xs rounded border border-border bg-background text-text-primary hover:bg-surface-elevated disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              onClick={form.goToNextTab}
              disabled={form.activeTab === questions.length - 1}
              tabIndex={-1}
            >
              Next →
            </button>
          </>
        )}
        <button
          onClick={onSkip}
          className="px-4 py-1.5 rounded border border-border bg-background text-text-secondary text-xs hover:bg-surface-elevated transition-colors"
          tabIndex={-1}
        >
          Skip
        </button>
        <button
          onClick={handleSubmit}
          disabled={!form.allAnswered}
          className="px-4 py-1.5 rounded bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          tabIndex={-1}
        >
          Submit {form.allAnswered ? "✓" : `(${questions.filter((_, i) => form.hasAnswer(i)).length}/${questions.length})`}
        </button>
      </div>
    </div>
  );
}
