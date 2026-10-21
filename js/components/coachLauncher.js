import { getState, subscribe, setSetting } from "../state.js";
import { track } from "../features/track.js";

const FAB_POS_KEY = "ss.coachfab.v1";
const FAB_SIZE = 52;
const COACH_HIDDEN_ROUTES = new Set(["", "/", "/login", "/register"]);
let fab;
let fabPos = loadFabPos();
const fabDrag = { active: false, moved: false, suppressClick: false };

function loadFabPos() {
  try {
    const p = JSON.parse(localStorage.getItem(FAB_POS_KEY) || "null");
    if (p && (p.side === "left" || p.side === "right")) {
      return { side: p.side, y: Number.isFinite(p.y) ? Math.min(1, Math.max(0, p.y)) : null, tucked: !!p.tucked };
    }
  } catch {}
  return { side: "right", y: null, tucked: false };
}

function saveFabPos() {
  try { localStorage.setItem(FAB_POS_KEY, JSON.stringify(fabPos)); } catch {}
}

function fabBounds() {
  const top = 72;
  const bottomBar = window.innerWidth <= 820 ? 84 : 16;
  const bottom = Math.max(top + 1, window.innerHeight - bottomBar - FAB_SIZE);
  return { top, bottom };
}

function placeFab() {
  if (!fab) return;
  fab.classList.toggle("is-left", fabPos.side === "left");
  fab.classList.toggle("is-tucked", !!fabPos.tucked);
  fab.setAttribute("aria-label", fabPos.tucked ? "Show coach button" : "Open coach");
  if (fabPos.y == null && fabPos.side === "right") {
    fab.classList.remove("is-placed");
    fab.style.top = "";
    return;
  }
  const { top, bottom } = fabBounds();
  const y = fabPos.y == null ? bottom : top + fabPos.y * (bottom - top);
  fab.classList.add("is-placed");
  fab.style.top = `${Math.round(y)}px`;
}

function wireFabDrag() {
  let startX = 0, startY = 0, startTop = 0, lastX = 0, lastT = 0, vx = 0;
  fab.style.touchAction = "none";
  fab.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    fabDrag.active = true; fabDrag.moved = false;
    startX = lastX = e.clientX; startY = e.clientY; lastT = e.timeStamp; vx = 0;
    startTop = fab.getBoundingClientRect().top;
    try { fab.setPointerCapture(e.pointerId); } catch {}
  });
  fab.addEventListener("pointermove", (e) => {
    if (!fabDrag.active) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!fabDrag.moved && Math.hypot(dx, dy) < 8) return;
    if (!fabDrag.moved) {
      fabDrag.moved = true;
      fab.classList.add("is-dragging", "is-placed");
      fab.classList.remove("is-tucked");
    }
    const dt = Math.max(1, e.timeStamp - lastT);
    vx = (e.clientX - lastX) / dt;
    lastX = e.clientX; lastT = e.timeStamp;
    const { top, bottom } = fabBounds();
    const y = Math.min(bottom, Math.max(top, startTop + dy));
    fab.style.top = `${Math.round(y)}px`;
    fab.style.left = `${Math.round(e.clientX - FAB_SIZE / 2)}px`;
    fab.style.right = "auto";
  });
  const end = (e) => {
    if (!fabDrag.active) return;
    fabDrag.active = false;
    if (!fabDrag.moved) return;
    fabDrag.suppressClick = true;
    setTimeout(() => { fabDrag.suppressClick = false; }, 400);
    fab.classList.remove("is-dragging");
    fab.style.left = ""; fab.style.right = "";
    const x = e.clientX, w = window.innerWidth;
    const side = x < w / 2 ? "left" : "right";
    const nearEdge = side === "left" ? x < 36 : x > w - 36;
    const flung = side === "left" ? vx < -0.9 : vx > 0.9;
    const { top, bottom } = fabBounds();
    const y = Math.min(bottom, Math.max(top, fab.getBoundingClientRect().top));
    fabPos = { side, y: bottom > top ? (y - top) / (bottom - top) : 1, tucked: nearEdge || flung };
    saveFabPos();
    placeFab();
  };
  fab.addEventListener("pointerup", end);
  fab.addEventListener("pointercancel", end);
}

function isCoachAllowed() {
  const path = location.pathname || "/";
  return getState().isAuthed && !COACH_HIDDEN_ROUTES.has(path);
}

function applyVisibility() {
  if (!fab) return;
  const allowed = isCoachAllowed();
  fab.style.display = allowed && !/^\/chat\/?$/.test(location.pathname) ? "" : "none";
}

export function mountCoachLauncher() {
  if (fab) return;
  if (window.innerWidth < 1280 && getState().settings.coachPanelOpen) {
    setSetting("coachPanelOpen", false);
  }

  fab = document.createElement("button");
  fab.className = "coach-fab";
  fab.setAttribute("aria-label", "Open coach");
  fab.innerHTML = "<span>💬</span>";
  fab.addEventListener("click", () => {
    if (fabDrag.suppressClick) { fabDrag.suppressClick = false; return; }
    if (fabPos.tucked) { fabPos.tucked = false; saveFabPos(); placeFab(); return; }
    const opening = !getState().settings.coachPanelOpen;
    setSetting("coachPanelOpen", opening);
    if (opening) track("coach_open", location.pathname.startsWith("/a/") ? "/a/[redacted]" : location.pathname);
  });
  document.body.appendChild(fab);
  wireFabDrag();
  placeFab();
  applyVisibility();
  window.addEventListener("resize", placeFab);
  window.addEventListener("ss:navigate", applyVisibility);
  subscribe(applyVisibility);
}
