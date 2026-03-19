import { useState, useCallback, useMemo, useEffect, useRef } from "react";

/* ── Types ── */
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface QuestionCardProps {
  questions: Question[];
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
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
    (qi: number) => {
      const custom = customInputs[qi]?.trim();
      if (custom) return custom;
      return (answers[qi] ?? []).join(", ");
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
  totalOptions: number;
  allAnswered: boolean;
  hasAnswer: (i: number) => boolean;
  onSelectOption: (i: number) => void;
  goToNextTab: () => void;
  goToPrevTab: () => void;
  onSubmit: () => void;
  customInputRef: React.RefObject<HTMLInputElement | null>;
  enabled: boolean;
}) {
  const [focusedOption, setFocusedOption] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setFocusedOption(0), [config.activeTab]);

  useEffect(() => {
    if (!config.enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const isTyping = document.activeElement === config.customInputRef.current;

      // Number keys 1-9
      if (!isTyping && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < config.totalOptions - 1) { setFocusedOption(idx); config.onSelectOption(idx); }
        return;
      }
      // O/0 → focus custom input
      if (!isTyping && (e.key === "o" || e.key === "O" || e.key === "0")) {
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
      if (!el.contains(document.activeElement)) el.focus();
    }
    return () => { el?.removeEventListener("keydown", handleKeyDown); };
  }, [config, focusedOption]);

  return { focusedOption, setFocusedOption, containerRef };
}

/* ── Component ── */
export function QuestionCard({ questions, onSubmit, onSkip }: QuestionCardProps) {
  const customInputRef = useRef<HTMLInputElement>(null);
  const form = useQuestionForm(questions);
  const currentQ = questions[form.activeTab];
  const totalOptions = currentQ ? currentQ.options.length + 1 : 0;
  const hasMultiple = questions.length > 1;

  const handleSubmit = useCallback(() => {
    if (!form.allAnswered) return;
    const result: Record<string, string> = {};
    questions.forEach((q, i) => { result[q.question] = form.getFinalAnswer(i); });
    onSubmit(result);
  }, [form.allAnswered, form.getFinalAnswer, questions, onSubmit]);

  const handleSelectOption = useCallback(
    (index: number) => {
      if (!currentQ || index < 0) return;
      if (index < currentQ.options.length) {
        const label = currentQ.options[index]?.label;
        if (!label) return;
        if (currentQ.multiSelect) form.handleMultiSelect(form.activeTab, label);
        else form.handleSingleSelect(form.activeTab, label);
      } else if (index === currentQ.options.length) {
        customInputRef.current?.focus();
      }
    },
    [currentQ, form],
  );

  const kb = useQuestionKeyboard({
    questions, activeTab: form.activeTab, totalOptions,
    allAnswered: form.allAnswered, hasAnswer: form.hasAnswer,
    onSelectOption: handleSelectOption,
    goToNextTab: form.goToNextTab, goToPrevTab: form.goToPrevTab,
    onSubmit: handleSubmit, customInputRef, enabled: true,
  });

  const selectWithFocus = useCallback(
    (index: number) => { handleSelectOption(index); kb.setFocusedOption(index); },
    [handleSelectOption, kb.setFocusedOption],
  );

  return (
    <div
      ref={kb.containerRef}
      className="rounded-lg border-2 border-primary/30 bg-primary/5 p-3 space-y-3 outline-none animate-in slide-in-from-bottom-2"
    >
      {/* Header */}
      <div className="flex items-center justify-between text-sm font-medium text-text-primary">
        <span>
          AI has {hasMultiple ? `${questions.length} questions` : "a question"}
        </span>
        <span className="text-[10px] text-text-secondary font-normal">
          {hasMultiple ? "←→ tabs · " : ""}↑↓ options · 1-{Math.min(totalOptions - 1, 9)} select · Enter submit
        </span>
      </div>

      {/* Tabs */}
      {hasMultiple && (
        <div className="flex gap-1 p-1 bg-background rounded-md overflow-x-auto border border-border">
          {questions.map((q, i) => (
            <button
              key={i}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs whitespace-nowrap transition-all ${
                form.activeTab === i
                  ? "bg-primary text-primary-foreground"
                  : form.hasAnswer(i)
                    ? "text-primary bg-transparent"
                    : "text-text-secondary hover:bg-surface-elevated"
              }`}
              onClick={() => { form.setActiveTab(i); kb.setFocusedOption(0); }}
              tabIndex={-1}
            >
              <span
                className={`flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold ${
                  form.activeTab === i
                    ? "bg-white/20"
                    : form.hasAnswer(i)
                      ? "bg-primary/20 text-primary"
                      : "bg-surface-elevated text-text-secondary"
                }`}
              >
                {form.hasAnswer(i) ? "✓" : i + 1}
              </span>
              <span className="max-w-[100px] overflow-hidden text-ellipsis">{q.header || `Q${i + 1}`}</span>
            </button>
          ))}
        </div>
      )}

      {/* Current question */}
      {currentQ && (
        <div className="space-y-2">
          {!hasMultiple && currentQ.header && (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{currentQ.header}</div>
          )}
          <div className="text-sm text-text-primary">{currentQ.question}</div>
          {currentQ.multiSelect && <div className="text-[11px] text-text-secondary">Select multiple</div>}

          {/* Options */}
          <div className="flex flex-col gap-1.5">
            {currentQ.options.map((opt, oi) => {
              const isSelected = (form.answers[form.activeTab] || []).includes(opt.label);
              const isFocused = kb.focusedOption === oi;
              return (
                <button
                  key={oi}
                  onClick={() => selectWithFocus(oi)}
                  className={`text-left flex items-start gap-2.5 rounded px-2.5 py-2 text-xs border transition-all ${
                    isSelected
                      ? "border-primary bg-primary/10 text-text-primary"
                      : "border-border bg-background text-text-secondary hover:border-primary/40 hover:bg-primary/5"
                  } ${isFocused ? "ring-2 ring-primary/40 ring-offset-1 ring-offset-background" : ""}`}
                >
                  <span className={`flex items-center justify-center w-4.5 h-4.5 rounded text-[10px] font-semibold shrink-0 mt-px ${
                    isSelected ? "bg-primary/20 text-primary" : "bg-surface-elevated text-text-secondary"
                  }`}>
                    {oi + 1}
                  </span>
                  <div className="flex flex-col gap-0.5 flex-1">
                    <span className="font-medium text-text-primary">{opt.label}</span>
                    {opt.description && <span className="text-[11px] text-text-secondary">{opt.description}</span>}
                  </div>
                </button>
              );
            })}

            {/* Other / custom input */}
            <div
              className={`flex items-start gap-2.5 rounded px-2.5 py-2 text-xs border border-dashed transition-all border-border bg-transparent ${
                kb.focusedOption === totalOptions - 1 ? "ring-2 ring-primary/40 ring-offset-1 ring-offset-background" : ""
              }`}
            >
              <span className="flex items-center justify-center w-4.5 h-4.5 rounded bg-surface-elevated text-text-secondary text-[10px] font-semibold shrink-0 mt-px">
                O
              </span>
              <input
                ref={customInputRef}
                type="text"
                className="flex-1 px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary outline-none placeholder:text-text-subtle focus:border-primary"
                placeholder="Other (press O to type)..."
                value={form.customInputs[form.activeTab] || ""}
                onChange={(e) => form.handleCustomInput(form.activeTab, e.target.value)}
                onFocus={() => kb.setFocusedOption(totalOptions - 1)}
              />
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
