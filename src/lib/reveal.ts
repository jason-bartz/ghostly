import { useEffect } from "react";

/**
 * "Take me to that thing, in the pane that owns it."
 *
 * Ask cites notes and meetings that live in two other panes, neither of which
 * is mounted while you are reading the answer — so a plain window event would
 * be dispatched into an empty room. The target is parked here first, the
 * navigation fires, and the destination claims it on mount.
 *
 * The follow-up event covers the other case: you are already in Notes and a
 * citation points at a second note there, so nothing mounts and there is no
 * mount effect to do the claiming.
 */
export interface RevealTarget {
  /** Sidebar section id that owns the target. */
  section: string;
  /** History entry id, for `section: "history"`. */
  noteId?: number;
  /** Meeting id, for `section: "meeting"`. */
  meetingId?: string;
}

const REVEAL_EVENT = "ghostly:reveal";

let pending: RevealTarget | null = null;

/** Navigate to `target.section` and hand it the thing to scroll to. */
export function revealInSection(target: RevealTarget): void {
  pending = target;
  window.dispatchEvent(
    new CustomEvent("ghostly:navigate", {
      detail: { section: target.section },
    }),
  );
  // After paint, so a destination that had to mount has already claimed it and
  // this is a no-op rather than a double delivery.
  requestAnimationFrame(() => window.dispatchEvent(new Event(REVEAL_EVENT)));
}

/**
 * Claim a pending reveal addressed to `section`.
 *
 * `onReveal` must be stable (wrap it in `useCallback`) — it is an effect
 * dependency, and an identity that changes every render would re-subscribe on
 * every render.
 */
export function useReveal(
  section: string,
  onReveal: (target: RevealTarget) => void,
): void {
  useEffect(() => {
    const claim = () => {
      if (pending === null || pending.section !== section) return;
      const target = pending;
      pending = null;
      onReveal(target);
    };
    claim();
    window.addEventListener(REVEAL_EVENT, claim);
    return () => window.removeEventListener(REVEAL_EVENT, claim);
  }, [section, onReveal]);
}
