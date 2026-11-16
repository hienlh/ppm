/**
 * The "Other" answer of one card in the set: the user's own words, and pictures if they want, sent
 * to the card's manager chat word for word. Pictures come in as the chat's composer takes them —
 * pasted, or chosen with the paperclip — scaled to the composer's size first, and travel as their
 * bytes: the server checks them and stores its own copy (it never takes a path from here).
 *
 * Typing or attaching makes this the card's answer, in place of a tile; clearing both takes it back.
 */
import { useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { Paperclip, X } from "@/lib/icons";
import { cn, randomId } from "@/lib/utils";
import { downscaleImage } from "@/lib/image-resize";
import { MAX_REPLY_IMAGES, type ReplyImage } from "@/lib/decision-set/decision-set-model";
import { INLINE_IMAGE_LIMITS } from "@/lib/image-resize-limits";
import { QuestionOtherRow, questionInputClass, type QuestionTone } from "@/components/chat/question-form-parts";
import { SET_ICON_BUTTON } from "./decision-set-buttons";

export interface ReplyValue {
  text: string;
  images: ReplyImage[];
}

/** File → base64 without the `data:` prefix. */
function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("The picture could not be read."));
    reader.readAsDataURL(file);
  });
}

/** A picture ready to send, or why it cannot be. */
async function readPicture(file: File): Promise<ReplyImage | string> {
  if (!file.type.startsWith("image/")) return `${file.name} is not a picture.`;
  const scaled = await downscaleImage(file);
  // Unmeasured, it could be larger than the server takes: the composer sends such a file by path,
  // which a card reply does not do.
  if (scaled.kind === "asis") return `${file.name} could not be read. Try a PNG or JPEG.`;
  const data = await toBase64(scaled.file);
  // The server's ceiling, the same as an image sent inline from the composer.
  if (data.length > INLINE_IMAGE_LIMITS.maxBase64PerImage) return `${file.name} is too large even after scaling. Try a smaller picture.`;
  return { id: randomId(), name: file.name || "pasted image", data, mediaType: scaled.file.type };
}

export function DecisionReplyField({ value, onChange, tone, focused, onFocus, inputRef, onKeyDown, placeholder, disabled }: {
  value: ReplyValue;
  onChange: (next: ReplyValue) => void;
  tone: QuestionTone;
  focused: boolean;
  onFocus: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest value, for a picture that finishes reading after the user typed on.
  const latest = useRef(value);
  latest.current = value;
  // Pictures still being read: two quick pastes must not make room for more than five together.
  const reading = useRef(0);

  async function add(files: readonly File[]) {
    setError(null);
    const room = MAX_REPLY_IMAGES - latest.current.images.length - reading.current;
    if (room <= 0) { setError(`At most ${MAX_REPLY_IMAGES} pictures in one reply.`); return; }
    const taken = files.slice(0, room);
    reading.current += taken.length;
    const read = await Promise.all(taken.map(readPicture)).finally(() => { reading.current -= taken.length; });
    const images = read.filter((r): r is ReplyImage => typeof r !== "string");
    const problems = read.filter((r): r is string => typeof r === "string");
    if (files.length > room) problems.push(`Only ${MAX_REPLY_IMAGES} pictures fit in one reply.`);
    if (problems.length) setError(problems.join(" "));
    if (images.length) onChange({ ...latest.current, images: [...latest.current.images, ...images] });
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void add(files);
  }

  const filled = value.text.trim().length > 0 || value.images.length > 0;
  return (
    <QuestionOtherRow tone={tone} focused={focused} filled={filled}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-start gap-1.5">
          <textarea
            ref={inputRef}
            rows={1}
            value={value.text}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
            onFocus={onFocus}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="Your own answer, sent to the manager chat word for word"
            // Grows with the words up to about six lines, then scrolls.
            className={cn(questionInputClass(tone), "field-sizing-content max-h-36 min-h-7 resize-none leading-snug")}
            data-decision-reply=""
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={disabled || value.images.length >= MAX_REPLY_IMAGES}
            aria-label="Attach a picture"
            title="Attach a picture (or paste one)"
            className={SET_ICON_BUTTON}
            data-decision-attach=""
          >
            <Paperclip />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; void add(files); }}
          />
        </div>
        {value.images.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Pictures in this reply" data-decision-reply-images="">
            {value.images.map((img) => (
              <li key={img.id} className="relative size-14 overflow-hidden rounded-md border border-border bg-panel-2">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} className="size-full object-cover" />
                <button
                  type="button"
                  onClick={() => onChange({ ...value, images: value.images.filter((i) => i.id !== img.id) })}
                  aria-label={`Remove ${img.name}`}
                  className="absolute right-0.5 top-0.5 grid size-6 place-items-center rounded-full bg-black/70 text-white max-md:size-[22px] [&_svg]:size-3.5"
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-[11px] text-error-ink" role="alert">{error}</p>}
      </div>
    </QuestionOtherRow>
  );
}
