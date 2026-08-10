import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookA,
  BrainCircuit,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { commands, type BillingCycle } from "@/bindings";
import { Button } from "../ui/Button";
import { GhostlyMark } from "../icons/GhostlyMark";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface IconProps {
  className?: string;
}

interface Benefit {
  key: string;
  Icon: React.ComponentType<IconProps>;
}

/**
 * What the subscription buys, in the order it becomes true for a new
 * subscriber: it works immediately, it picks its own models, and then the three
 * things that need a server to exist at all.
 *
 * Every line is something shipped. Nothing on this page is a roadmap item —
 * a benefits list that quietly includes futures is the fastest way to make the
 * rest of it untrustworthy.
 */
const BENEFITS: readonly Benefit[] = [
  { key: "noKey", Icon: KeyRound },
  { key: "routing", Icon: BrainCircuit },
  { key: "ask", Icon: Sparkles },
  { key: "vocabulary", Icon: BookA },
  { key: "sync", Icon: RefreshCw },
  { key: "privacy", Icon: ShieldCheck },
];

interface MaxUpgradePageProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * The Ghostly Max page — the pitch, the price, and the way to buy it, without
 * leaving the app.
 *
 * Every upgrade affordance in the app used to open a browser: either the
 * website's pricing section or, worse, a bare Stripe form. Both ask for the
 * decision somewhere the user can't see the thing they were just using. This
 * makes the case in place and keeps the browser for the one step that has to
 * happen there — entering a card.
 *
 * A sheet rather than a sidebar destination: it is reached from half a dozen
 * panes, and a nav item that appeared only when you weren't subscribed would
 * be an advert bolted to the furniture.
 */
export const MaxUpgradePage: React.FC<MaxUpgradePageProps> = ({
  open,
  onClose,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<BillingCycle | null>(null);

  useFocusTrap(dialogRef as React.RefObject<HTMLElement>, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const checkout = useCallback(async (cycle: BillingCycle) => {
    setBusy(cycle);
    try {
      const res = await commands.openCheckout(cycle);
      if (res.status === "error") toast.error(String(res.error));
    } finally {
      setBusy(null);
    }
  }, []);

  if (!open) return null;

  return (
    // No `app-canvas` on this element, and that omission is the fix for the bug
    // this shipped with: `.app-canvas` declares `position: relative` as a plain
    // rule loaded after Tailwind, so it beat the `fixed` utility and the sheet
    // was never an overlay. It laid out in normal flow under the app's footer
    // and got sheared off at the window edge. `.modal-scrim` alone paints the
    // backdrop; an overlay has no use for the app's background gradient.
    <div
      className="modal-scrim fixed inset-0 z-50 overflow-y-auto"
      onClick={onClose}
    >
      {/* Scrolling and centring are split across two elements on purpose.
          Centring the card directly inside the scroll container — `justify-center`
          out here, `my-auto` on the card — looks right only while the card
          fits. Once it is taller than the window, auto margins push its top
          above the scroll origin, where no amount of scrolling can reach it:
          the heading is sheared off and the fine print at the bottom collides
          with the footer. `min-h-full` on an inner flex wrapper centres a short
          card and lets a tall one grow the scrollable area instead. */}
      <div className="flex min-h-full items-center justify-center p-6">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="max-upgrade-title"
          onClick={(e) => e.stopPropagation()}
          className="glass-raised animate-rise w-full max-w-3xl overflow-hidden rounded-2xl"
        >
          <Hero onClose={onClose} />

          {/* Hairline-gapped grid: the 1px background shows through the gaps, so
            the cards read as panes of one surface rather than six floating
            cards with their own borders. */}
          <div className="grid gap-px bg-hairline sm:grid-cols-2">
            {BENEFITS.map(({ key, Icon }) => (
              <div key={key} className="bg-surface-1/60 px-6 py-5">
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-accent-bright" />
                  <div className="space-y-1">
                    <p className="text-[13px] font-semibold text-text">
                      {t(`max.upgrade.benefits.${key}.title`)}
                    </p>
                    <p className="text-[12.5px] leading-relaxed text-text-muted">
                      {t(`max.upgrade.benefits.${key}.body`)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-hairline px-8 py-7">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-semibold tracking-tight text-text">
                    {t("max.upgrade.price.amount")}
                  </span>
                  <span className="text-sm text-text-muted">
                    {t("max.upgrade.price.period")}
                  </span>
                </div>
                <p className="mt-1.5 text-[12.5px] text-text-muted">
                  {t("max.upgrade.price.yearly")}
                </p>
              </div>

              <div className="flex flex-col items-stretch gap-2">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => void checkout("monthly")}
                  disabled={busy !== null}
                >
                  <span className="inline-flex items-center gap-2">
                    {busy === "monthly" ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Sparkles className="h-4 w-4" aria-hidden />
                    )}
                    {t("max.upgrade.cta")}
                  </span>
                </Button>
                <button
                  type="button"
                  onClick={() => void checkout("yearly")}
                  disabled={busy !== null}
                  className="text-center text-[11.5px] text-text-muted underline-offset-2
                           hover:text-text hover:underline disabled:opacity-50 cursor-pointer"
                >
                  {t("max.upgrade.payYearly")}
                </button>
              </div>
            </div>

            <p className="mt-5 text-[11.5px] leading-relaxed text-text-faint">
              {t("max.upgrade.finePrint")}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-fill-1 px-8 py-3.5">
            <button
              type="button"
              onClick={() => {
                onClose();
                window.dispatchEvent(
                  new CustomEvent("ghostly:navigate", {
                    detail: { section: "account" },
                  }),
                );
              }}
              className="text-[12px] text-text-muted underline-offset-2 hover:text-text hover:underline cursor-pointer"
            >
              {t("max.upgrade.haveKey")}
            </button>
            <button
              type="button"
              onClick={() => void commands.openPaymentLink()}
              className="text-[12px] text-text-faint underline-offset-2 hover:text-text-muted hover:underline cursor-pointer"
            >
              {t("max.upgrade.compare")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface HeroProps {
  readonly onClose: () => void;
}

/**
 * The top of the sheet: an accent wash, an oversized mark set into the right
 * side, and the one sentence the whole page argues for.
 *
 * The mark is decorative and large on purpose — at 12% opacity it reads as a
 * watermark on stationery rather than a logo, which is what stops the header
 * from looking like a dialog with a badge stuck to it. It sits fully inside the
 * header: cropped, the ghost's silhouette stops being a ghost and starts being
 * a smear.
 */
const Hero: React.FC<HeroProps> = ({ onClose }) => {
  const { t } = useTranslation();
  return (
    <header className="relative overflow-hidden bg-gradient-to-b from-accent/12 to-transparent px-8 pb-8 pt-9">
      <GhostlyMark
        aria-hidden
        className="pointer-events-none absolute right-6 top-5 h-40 text-accent/12"
      />

      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close", "Close")}
        className="absolute right-4 top-4 rounded-lg p-1.5 text-text-faint transition-colors
                   hover:bg-fill-2 hover:text-text focus:outline-none
                   focus-visible:ring-2 focus-visible:ring-accent/40 cursor-pointer"
      >
        <X className="h-4 w-4" />
      </button>

      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-bright">
        {t("max.upgrade.eyebrow")}
      </p>
      <h1
        id="max-upgrade-title"
        className="mt-2 max-w-lg text-[26px] font-semibold leading-tight tracking-tight text-text"
      >
        {t("max.upgrade.headline")}
      </h1>
      <p className="mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-text-muted">
        {t("max.upgrade.subhead")}
      </p>
    </header>
  );
};
