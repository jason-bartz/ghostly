import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Sparkles } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { KeyCombo, StepHeader, SuccessCheck, Waveform } from "../parts";
import type { TourStepProps } from "../types";

type Phase = "waiting" | "listening" | "transcribing" | "done";

/** How long after the last audio frame we call the recording finished. */
const AUDIO_IDLE_MS = 450;

const countWords = (text: string) =>
  text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Lines to read aloud.
 *
 * "Say something" in front of an empty box is a small performance anxiety —
 * people freeze, or mumble one word, and the demo under-sells itself. Each of
 * these is a sentence someone would actually dictate, and each contains
 * punctuation the model has to infer: a comma, a question mark, a capitalised
 * day. Reading one out loud shows off more than "testing, testing" ever would.
 */
const PROMPT_COUNT = 3;

/**
 * The moment the product sells itself.
 *
 * Every onboarding that only *describes* a hotkey loses people at the first
 * real use, because nothing has confirmed the thing works on their machine.
 * This step is a genuine text field: the user presses their real shortcut, the
 * real pipeline runs, and their own words land in front of them. It is also
 * the first honest test of permissions, microphone, and model — if anything is
 * broken, it surfaces here, inside a flow that can explain it.
 */
export const PracticeStep: React.FC<TourStepProps> = ({ setFooter }) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("waiting");
  const [levels, setLevels] = useState<number[]>([]);
  const [dictated, setDictated] = useState(false);
  // Frozen at the moment of dictation. Deriving it from the live field meant
  // that clearing the box afterwards left the celebration reading
  // "0 words, no typing" over an empty textarea.
  const [dictatedWords, setDictatedWords] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idleTimerRef = useRef<number | null>(null);
  const sawAudioRef = useRef(false);
  const phaseRef = useRef<Phase>("waiting");

  const binding = settings?.bindings?.transcribe?.current_binding ?? "fn";
  // One line per visit, so a replay doesn't read like the same script.
  const [promptIndex] = useState(() =>
    Math.floor(Math.random() * PROMPT_COUNT),
  );

  phaseRef.current = phase;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // The forward button keeps saying "Continue" whether or not they've tried
  // it. Relabelling it "Skip this" would make skipping the loudest, most
  // violet thing on the step someone is meant to *do*.
  useEffect(() => {
    setFooter({
      hint: dictated ? t("tour.practice.doneHint") : t("tour.practice.hint"),
    });
  }, [dictated, setFooter, t]);

  // Live input meter. The backend emits `mic-level` for the whole app, not
  // just the overlay, so the meter here is the same signal the overlay draws.
  useEffect(() => {
    const unlisten = listen<number[]>("mic-level", (event) => {
      sawAudioRef.current = true;
      setLevels(event.payload);
      if (phaseRef.current !== "done") setPhase("listening");

      // Audio stops arriving the instant the key is released; that gap is what
      // tells us to switch from "listening" to "transcribing".
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        setLevels([]);
        setPhase((p) => (p === "listening" ? "transcribing" : p));
      }, AUDIO_IDLE_MS);
    });
    return () => {
      void unlisten.then((fn) => fn());
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    // A dictation lands as one large insertion; typing arrives a character at
    // a time. Either way the user gets to keep what's in the box — only the
    // celebration is gated on this actually having been spoken.
    const inserted = next.length - text.length;
    if (next.trim() && (inserted > 3 || sawAudioRef.current)) {
      setDictated(true);
      setDictatedWords((prev) => Math.max(prev, countWords(next)));
      setPhase("done");
    }
    setText(next);
  };

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        eyebrow={t("tour.practice.eyebrow")}
        title={t("tour.practice.title")}
        body={t("tour.practice.body")}
      />

      {/* Fixed-height stage: the status strip and meter swap in place so the
          text field never moves under the user's cursor. */}
      <div
        data-rise
        style={{ "--i": 1 } as React.CSSProperties}
        className="surface-card-inlay p-4 flex flex-col gap-3"
      >
        <div className="h-[46px] flex items-center justify-center">
          {phase === "waiting" && (
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-text-muted">
                {t("tour.practice.press")}
              </span>
              <KeyCombo binding={binding} />
              <span className="text-[12.5px] text-text-muted">
                {t("tour.practice.andSpeak")}
              </span>
            </div>
          )}
          {phase === "listening" && (
            <div className="flex items-center gap-3 w-full">
              <span className="text-[12px] font-medium text-accent-bright shrink-0">
                {t("tour.practice.listening")}
              </span>
              <Waveform
                levels={levels}
                bars={25}
                height={34}
                className="flex-1"
              />
            </div>
          )}
          {phase === "transcribing" && (
            <div className="flex items-center gap-2 text-[12.5px] text-text-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t("tour.practice.transcribing")}
            </div>
          )}
          {phase === "done" && (
            <div className="flex items-center gap-2.5">
              <SuccessCheck size={26} />
              <span className="text-[12.5px] font-medium text-success">
                {/* `words`, not `count` — `count` would send i18next looking
                    for plural variants of this key that don't exist. */}
                {t("tour.practice.success", { words: dictatedWords })}
              </span>
            </div>
          )}
        </div>

        {/* Something to read aloud. Kept in place (not removed) after a
            successful dictation so the stage height never changes. */}
        <p
          className={`text-center text-[13px] leading-snug transition-opacity duration-500 ${
            dictated ? "opacity-35" : "opacity-100"
          }`}
        >
          <span className="text-[11px] uppercase tracking-[0.06em] text-text-faint me-2">
            {t("tour.practice.trySaying")}
          </span>
          <span className="italic-serif text-accent-bright">
            {t(`tour.practice.prompts.${promptIndex}`)}
          </span>
        </p>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          spellCheck={false}
          placeholder={t("tour.practice.placeholder")}
          className="w-full h-[104px] resize-none rounded-lg bg-fill-1 border border-hairline focus:border-accent/45 focus:outline-none px-3.5 py-3 text-[13.5px] leading-relaxed text-text placeholder:text-text-faint transition-colors select-text cursor-text"
        />
      </div>

      {/* The payoff line, and the one place to say "this never left your Mac". */}
      <div
        data-rise
        style={{ "--i": 2 } as React.CSSProperties}
        className={`px-4 py-3 rounded-xl border transition-colors duration-500 ${
          dictated
            ? "bg-success/[0.06] border-success/25"
            : "surface-card border-hairline"
        }`}
      >
        <div className="flex items-start gap-3">
          <Sparkles
            className={`w-4 h-4 mt-0.5 shrink-0 ${
              dictated ? "text-success" : "text-accent-bright"
            }`}
          />
          <p className="text-[12px] text-text-muted leading-relaxed">
            {dictated
              ? t("tour.practice.afterBody")
              : t("tour.practice.beforeBody")}
          </p>
        </div>
      </div>
    </div>
  );
};

export default PracticeStep;
