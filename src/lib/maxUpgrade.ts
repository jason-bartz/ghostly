const SHOW_MAX_EVENT = "ghostly:show-max";

/**
 * Open the in-app Ghostly Max page.
 *
 * Every route to the subscription goes through here rather than opening Stripe
 * directly. Someone who clicks "Max feature" on a locked pane has been told
 * what they can't do and nothing about what they'd be buying; dropping them on
 * a checkout form asks for a card before making the case for it.
 */
export function showMaxUpgrade(): void {
  window.dispatchEvent(new Event(SHOW_MAX_EVENT));
}

/** Subscribe to open requests. Returns the unsubscribe function. */
export function onShowMaxUpgrade(handler: () => void): () => void {
  window.addEventListener(SHOW_MAX_EVENT, handler);
  return () => window.removeEventListener(SHOW_MAX_EVENT, handler);
}
