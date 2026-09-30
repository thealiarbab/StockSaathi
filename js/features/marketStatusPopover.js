// =============================================================================
// MARKET-STATUS POPOVER — Mobile-friendly behaviour for the .market-status
// badge's hover card.
//
// Desktop uses :hover / :focus-within CSS. That's enough there.
//
// Mobile: hover doesn't exist. We toggle a `.ms-open` class on tap/click,
// which the bottom-sheet CSS uses. Tapping outside any open popover closes
// it. Tapping a DIFFERENT badge closes the first and opens the second.
// Escape also closes.
// =============================================================================

let mounted = false;

function closeAll(except) {
  document.querySelectorAll(".market-status.ms-open").forEach(el => {
    if (el !== except) el.classList.remove("ms-open");
  });
}

function isTouch() {
  return matchMedia("(hover: none)").matches || matchMedia("(pointer: coarse)").matches;
}

function onClick(e) {
  const badge = e.target.closest(".market-status");
  // Tapping inside the popover itself shouldn't do anything — let content
  // be readable / selectable.
  if (e.target.closest(".market-status-pop")) return;
  if (!badge) {
    closeAll();
    return;
  }
  // Only intercept on touch-primary devices; on desktop we let the CSS
  // hover do its thing (clicking shouldn't flip it open/closed).
  if (!isTouch()) return;
  e.preventDefault();
  const alreadyOpen = badge.classList.contains("ms-open");
  closeAll(badge);
  if (!alreadyOpen) badge.classList.add("ms-open");
  else badge.classList.remove("ms-open");
}

function onKeydown(e) {
  if (e.key === "Escape") closeAll();
}

export function mountMarketStatusPopover() {
  if (mounted) return;
  mounted = true;
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("ss:navigate", () => closeAll());
  window.addEventListener("scroll", () => closeAll(), { passive: true });
}
