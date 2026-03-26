import { useState, useRef, useCallback } from "react";

// Extend Window for webkit prefix
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoiceInput(options?: { lang?: string }) {
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // Accumulate finalized text across multiple result events
  const finalizedRef = useRef("");

  const supported = typeof window !== "undefined" && getSpeechRecognition() !== null;

  const start = useCallback(
    (onResult: (text: string, isFinal: boolean) => void) => {
      const SR = getSpeechRecognition();
      if (!SR) return;

      // Stop any existing session
      recognitionRef.current?.abort();

      const recognition = new SR();
      recognition.lang = options?.lang ?? "vi-VN";
      recognition.continuous = true;
      recognition.interimResults = true;

      finalizedRef.current = "";

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = "";
        let newFinalized = "";

        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i]!;
          if (result.isFinal) {
            newFinalized += result[0]!.transcript;
          } else {
            interim += result[0]!.transcript;
          }
        }

        // Update finalized accumulator
        if (newFinalized) {
          finalizedRef.current = newFinalized;
        }

        const fullText = (finalizedRef.current + " " + interim).trim();
        setInterimText(interim);
        onResult(fullText, interim.length === 0 && finalizedRef.current.length > 0);
      };

      recognition.onend = () => {
        setIsListening(false);
        setInterimText("");
        // Deliver final text if any
        if (finalizedRef.current) {
          onResult(finalizedRef.current.trim(), true);
        }
      };

      recognition.onerror = (event) => {
        // "no-speech" and "aborted" are expected, not real errors
        if (event.error !== "no-speech" && event.error !== "aborted") {
          console.warn("[voice-input] error:", event.error);
        }
        setIsListening(false);
        setInterimText("");
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsListening(true);
    },
    [options?.lang],
  );

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
    setInterimText("");
  }, []);

  return { isListening, interimText, start, stop, supported };
}
