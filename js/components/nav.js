// =============================================================================
// NAV — StockSaathi top navigation, auth-aware + mobile drawer.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";
import { logoutAccount } from "../auth/accounts.js";
import { formatRupees } from "../money.js";
import { marketStatus } from "../data/prices.js";
import { navigate, currentRoute } from "../router.js";
import { switchUser } from "../state.js";

const LINKS_AUTH = [
  { route: "portfolio", label: "Portfolio", icon: "📊" },
  { route: "stocks",    label: "Markets",   icon: "📈" },
  { route: "news",      label: "News",      icon: "📰" },
  { route: "chat",      label: "Coach Chat", icon: "💬" },
  { route: "crash-replay", label: "Time Travel", icon: "⏱" },
  { route: "friends",   label: "Friends",   icon: "👥" },
  { route: "report-card", label: "Report Card", icon: "📋" },
];

const LINKS_PUBLIC = [
  { route: "chat",         label: "Coach Chat", icon: "💬" },
  { route: "crash-replay", label: "Time Travel", icon: "⏱" },
  { route: "news",         label: "News",       icon: "📰" },
];

// Top bar on desktop. Leaderboard removed Apr 24 2026 — see router.js
// for the full reasoning. Friends, Report card, Settings live in the
// avatar dropdown since they're less frequently accessed.
const DESKTOP_TOP_AUTH = ["portfolio", "stocks", "news", "chat", "crash-replay"];

export function mountNav() {
  const root = document.getElementById("nav-root");
  if (!root) return;
  render();
  subscribe(render);
  window.addEventListener("ss:navigate", render);

  // Click-outside closes user dropdown
  document.addEventListener("click", (e) => {
    const dd = root.querySelector(".dropdown");
    if (dd && !dd.contains(e.target)) dd.classList.remove("open");
    const drawer = document.getElementById("nav-drawer");
    if (drawer?.classList.contains("open") &&
        !drawer.querySelector(".nav-drawer-panel").contains(e.target) &&
        !e.target.closest(".nav-burger") &&
        !e.target.closest("[data-mobile-menu]")) {
      // ^ also exclude the mobile bottom-nav "More" button — otherwise the
      // same click that opens the drawer bubbles up and closes it
      // immediately, making the button appear broken.
      closeDrawer();
    }
  });

  // Close drawer on escape + on hashchange
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  window.addEventListener("ss:navigate", closeDrawer);

  function render() {
    const state = getState();
    const active = currentRoute().name;
    const allLinks = state.isAuthed ? LINKS_AUTH : LINKS_PUBLIC;
    const topLinks = state.isAuthed
      ? allLinks.filter(l => DESKTOP_TOP_AUTH.includes(l.route))
      : allLinks;
    const pfValue = state.isAuthed ? (state.portfolio.cashPaise + computeHoldingsValue(state)) : 0;
    const ms = marketStatus();

    // Mobile bottom nav — 5 primary destinations (or 4 + a menu button).
    // CSS hides this on desktop (≥821px). The same `active` state highlights
    // the current route. Taps go directly to the route — no burger → drawer
    // → item indirection, which is what was causing the "laggy nav" feel on
    // Android phones.
    // Logged-out users don't have the Settings route or a dropdown, so the
    // only top-bar theme toggle we can offer them is the 36px nav-theme-toggle
    // button — which on narrow phones competes for space with Log in / Sign
    // up buttons in nav-right. To make dark-mode guaranteed-reachable in the
    // thumb-zone on mobile, slot a dedicated theme toggle into the mobile
    // bottom-nav for unauthed users (route === "__theme" is handled below
    // as a button instead of an anchor). Authed users already have the
    // drawer's "More" entry + Settings page + Settings → Appearance, so we
    // don't add a 6th item to their bottom nav.
    const themeIsDark = (state.settings.theme || "light") === "dark";
    const themeIcon = themeIsDark ? "☀️" : "🌙";
    const themeLabel = themeIsDark ? "Light" : "Dark";
    const mobileNavItems = state.isAuthed
      ? [
          { route: "portfolio",    label: "Home",   icon: "🏠" },
          { route: "stocks",       label: "Markets", icon: "📈" },
          { route: "chat",         label: "Coach",  icon: "💬" },
          { route: "crash-replay", label: "Replay", icon: "⏱" },
          { route: "__menu",       label: "More",   icon: "☰" },
        ]
      : [
          // The header's theme toggle only looked "missing" because this bar
          // used to render inside the header and cover it (see below), so the
          // bar no longer needs its own Dark/Light slot.
          { route: "",             label: "Home",   icon: "🏠" },
          { route: "stocks",       label: "Markets", icon: "📈" },
          { route: "chat",         label: "Coach",  icon: "💬" },
          { route: "crash-replay", label: "Replay", icon: "⏱" },
          { route: "login",        label: "Log in", icon: "🔑" },
        ];
    const mobileNavHtml = `
      <nav class="mobile-bottom-nav" aria-label="Primary">
        ${mobileNavItems.map(item => {
          const isActive = item.route && active === item.route;
          if (item.route === "__menu") {
            return `<button type="button" class="mbn-link" data-mobile-menu aria-label="Open menu">
              <span class="mbn-link-icon" aria-hidden="true">${item.icon}</span>
              <span class="mbn-link-label">${item.label}</span>
            </button>`;
          }
          if (item.route === "__theme") {
            return `<button type="button" class="mbn-link" data-mobile-theme aria-label="Toggle dark mode">
              <span class="mbn-link-icon" aria-hidden="true">${item.icon}</span>
              <span class="mbn-link-label">${item.label}</span>
            </button>`;
          }
          return `<a href="/${item.route}" class="mbn-link ${isActive ? "active" : ""}">
            <span class="mbn-link-icon" aria-hidden="true">${item.icon}</span>
            <span class="mbn-link-label">${item.label}</span>
          </a>`;
        }).join("")}
      </nav>
    `;

    // The bottom tab bar lives OUTSIDE the header: .nav has backdrop-filter,
    // which makes it the containing block for position:fixed descendants, so
    // inside it the "bottom" bar was pinned to the header and covered the
    // logo, Ask and menu buttons on every phone.
    let mobileRoot = document.getElementById("mobile-nav-root");
    if (!mobileRoot) {
      mobileRoot = document.createElement("div");
      mobileRoot.id = "mobile-nav-root";
      document.body.appendChild(mobileRoot);
    }
    mobileRoot.innerHTML = mobileNavHtml;

    root.innerHTML = `
      <div class="nav-inner">
        <a href="${state.isAuthed ? "/portfolio" : "/"}" class="brand-logo" aria-label="StockSaathi home">
          <span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 64 64" width="22" height="22" style="display:block;"><path d="M16 40 L26 28 L34 36 L48 20" stroke="white" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="48" cy="20" r="3.5" fill="white"/></svg></span>
          <span>StockSaathi</span>
        </a>

        <nav class="nav-links" aria-label="Main navigation">
          ${topLinks.map(l => `
            <a href="/${l.route}" class="nav-link ${active === l.route ? "active" : ""}">${l.label}</a>
          `).join("")}
        </nav>

        <div class="nav-right">
          <button id="cmdk-open-btn" class="nav-cmdk-btn" type="button" aria-label="Ask Saathi (Ctrl+K)" title="Ask Saathi  ⌘K">
            <span aria-hidden="true">✨</span>
            <span class="nav-cmdk-label">Ask</span>
            <kbd class="nav-cmdk-kbd">⌘K</kbd>
          </button>
          ${themeToggleHtml(state.settings.theme)}
          ${state.isAuthed ? `
            <div class="market-status" tabindex="0" aria-label="NSE market status" data-ms-state="${ms.state}">
              <span class="dot ${ms.open ? "" : ms.state === "pre-open" ? "preopen" : "closed"}"></span>
              <span class="muted">NSE · ${ms.state === "open" ? "Live" : ms.state === "pre-open" ? "Pre-open" : "Closed"}</span>
              <span class="dim text-xs" style="margin-left: 6px;">${escapeHtml(ms.istTime)}</span>
              <div class="market-status-pop" role="tooltip">
                <div class="ms-pop-head">
                  <span class="ms-pop-label">NSE · ${ms.state === "open" ? "Live" : ms.state === "pre-open" ? "Pre-open" : "Closed"}</span>
                  ${ms.degraded ? '<span class="ms-pop-dim">~</span>' : ""}
                </div>
                <div class="ms-pop-row"><span class="ms-pop-key">Now</span><span>${escapeHtml(ms.istDate)} · ${escapeHtml(ms.istTime)}</span></div>
                ${ms.state === "open"
                  ? `<div class="ms-pop-row"><span class="ms-pop-key">Closes</span><span>3:30 PM IST today</span></div>`
                  : `<div class="ms-pop-row"><span class="ms-pop-key">${ms.state === "pre-open" ? "Opens" : "Last close"}</span><span>${ms.state === "pre-open" ? "9:15 AM IST today" : escapeHtml(ms.lastCloseLabel || "—")}</span></div>`
                }
                ${ms.state !== "open" && ms.nextOpenLabel ? `<div class="ms-pop-row"><span class="ms-pop-key">Next open</span><span>${escapeHtml(ms.nextOpenLabel)}</span></div>` : ""}
                ${ms.isHoliday ? `<div class="ms-pop-row"><span class="ms-pop-key">Holiday</span><span>Yes</span></div>` : ""}
                <div class="ms-pop-row"><span class="ms-pop-key">Hours</span><span>Mon–Fri · 9:15 AM – 3:30 PM IST</span></div>
                <div class="ms-pop-foot">Clock is server-trusted. Changing your system time won't move it.</div>
              </div>
            </div>
            <div class="nav-cash" aria-label="Portfolio value">
              <span class="label">Portfolio</span>
              <span class="val tabular">${formatRupees(pfValue, { compact: true })}</span>
            </div>
            <div class="dropdown" id="user-dd">
              <button class="nav-avatar" id="user-avatar" aria-label="Account menu" aria-expanded="false">
                ${initials(state.user.displayName || state.user.username)}
              </button>
              <div class="dropdown-menu" role="menu">
                <div style="padding: 10px 12px;">
                  <div class="font-semi">${escapeHtml(state.user.displayName || "")}</div>
                  <div class="muted text-xs">@${escapeHtml(state.user.username || "")}</div>
                </div>
                <div class="dropdown-divider"></div>
                <a class="dropdown-item" href="/report-card">📋 Report card</a>
                <a class="dropdown-item" href="/friends">👥 Friends & transfers</a>
                <a class="dropdown-item" href="/settings">⚙️ Settings</a>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item danger" id="logout-btn">Log out</button>
              </div>
            </div>
          ` : `
            <a href="/login" class="btn btn-ghost btn-sm nav-auth-btn">Log in</a>
            <a href="/register" class="btn btn-primary btn-sm nav-auth-btn">Sign up</a>
          `}
          <button class="nav-burger" aria-label="Open menu" id="nav-burger-btn">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M4 7h16M4 12h16M4 17h16"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    ensureDrawer();
    renderDrawer(state, allLinks, active, pfValue, ms);

    const avatar = root.querySelector("#user-avatar");
    const dd = root.querySelector("#user-dd");
    avatar?.addEventListener("click", (e) => {
      e.stopPropagation();
      dd.classList.toggle("open");
      avatar.setAttribute("aria-expanded", dd.classList.contains("open"));
    });
    root.querySelector("#logout-btn")?.addEventListener("click", async (e) => {
      // Disable while pending so a double-click can't fire two parallel
      // signOut requests + race the navigation. Logout button text gets
      // a brief 'Signing out...' so the user has feedback if signOut
      // happens to be slow (sub-3s expected, 3s hard timeout in
      // logoutAccount itself).
      const btn = e.currentTarget;
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1";
      const orig = btn.textContent;
      btn.textContent = "Signing out…";
      try {
        await logoutAccount();
      } finally {
        switchUser();
        navigate("/");
        // Best-effort restore (the nav re-renders on navigate so this
        // is mostly defensive in case the nav-rerender doesn't fire).
        try { btn.textContent = orig; btn.dataset.busy = "0"; } catch {}
      }
    });
    root.querySelector("#nav-burger-btn")?.addEventListener("click", openDrawer);
    // Mobile bottom nav "More" button opens the same drawer as the top-bar
    // burger — keeps the full nav menu reachable in one tap from anywhere.
    mobileRoot.querySelector("[data-mobile-menu]")?.addEventListener("click", openDrawer);
    mobileRoot.querySelector("[data-mobile-theme]")?.addEventListener("click", toggleTheme);
    root.querySelector("#theme-toggle-btn")?.addEventListener("click", toggleTheme);
    root.querySelector("#cmdk-open-btn")?.addEventListener("click", () => {
      import("./commandPalette.js").then(m => m.openCommandPalette());
    });
  }
}

// Site-wide theme toggle. Accessible from every page without diving into
// Settings. State change propagates via the existing subscribe() wired
// in app.js, which flips the <html data-theme="…"> attribute, which all
// CSS vars are keyed off.
function toggleTheme() {
  const cur = getState().settings.theme || "light";
  const next = cur === "dark" ? "light" : "dark";
  setSetting("theme", next);
}

function themeToggleHtml(theme) {
  const isDark = (theme || "light") === "dark";
  // Sun icon when dark (click → go light), moon when light (click → go dark).
  const icon = isDark
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  return `<button id="theme-toggle-btn" class="nav-theme-toggle" type="button" aria-label="${isDark ? "Switch to light mode" : "Switch to dark mode"}" title="${isDark ? "Switch to light mode" : "Switch to dark mode"}">${icon}</button>`;
}

// ---------------------------------------------------------------------------
// Mobile drawer
// ---------------------------------------------------------------------------

function ensureDrawer() {
  if (document.getElementById("nav-drawer")) return;
  const drawer = document.createElement("div");
  drawer.id = "nav-drawer";
  drawer.className = "nav-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-hidden", "true");
  drawer.innerHTML = `
    <div class="nav-drawer-backdrop" data-close></div>
    <div class="nav-drawer-panel"></div>
  `;
  document.body.appendChild(drawer);
  drawer.querySelector("[data-close]").addEventListener("click", closeDrawer);
}

function renderDrawer(state, allLinks, active, pfValue, ms) {
  const drawer = document.getElementById("nav-drawer");
  if (!drawer) return;
  const panel = drawer.querySelector(".nav-drawer-panel");
  panel.innerHTML = `
    <div class="drawer-head">
      <div class="brand-logo">
        <span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 64 64" width="22" height="22" style="display:block;"><path d="M16 40 L26 28 L34 36 L48 20" stroke="white" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="48" cy="20" r="3.5" fill="white"/></svg></span>
        <span>StockSaathi</span>
      </div>
      <button class="btn btn-ghost btn-icon" aria-label="Close menu" data-close-drawer>✕</button>
    </div>

    ${state.isAuthed ? `
      <div class="drawer-stat">
        <div class="muted text-xs" style="text-transform: uppercase; letter-spacing: 0.05em;">Portfolio</div>
        <div class="val">${formatRupees(pfValue, { compact: true })}</div>
        <div class="text-xs ${ms.open ? "up" : "muted"}" style="margin-top: 4px;">
          ${ms.open ? "● NSE open" : ms.state === "pre-open" ? "◐ NSE pre-open" : "○ NSE closed"} · ${ms.istDate} · ${ms.istTime}
          ${ms.state !== "open" && ms.nextOpenLabel ? `<br><span class="dim">${ms.nextOpenLabel}</span>` : ""}
          ${ms.isHoliday ? '<br><span class="dim">Holiday today</span>' : ""}
        </div>
      </div>
    ` : ""}

    <div class="drawer-section">Navigate</div>
    ${allLinks.map(l => `
      <a href="/${l.route}" class="drawer-link ${active === l.route ? "active" : ""}" data-close-on-click>
        <span>${l.icon} ${l.label}</span>
        <span class="muted">›</span>
      </a>
    `).join("")}

    <div class="drawer-divider"></div>
    <button class="drawer-link" id="drawer-theme-toggle" type="button" style="text-align: left;">
      <span>${(state.settings.theme || "light") === "dark" ? "☀️ Light mode" : "🌙 Dark mode"}</span>
      <span class="muted">↔</span>
    </button>

    ${state.isAuthed ? `
      <div class="drawer-divider"></div>
      <div class="drawer-section">${escapeHtml(state.user.displayName || state.user.username || "")}</div>
      <a href="/settings" class="drawer-link" data-close-on-click>
        <span>⚙️ Settings</span>
        <span class="muted">›</span>
      </a>
      <button class="drawer-link" id="drawer-logout" style="text-align: left; color: var(--negative);">
        <span>↪ Log out</span>
      </button>
    ` : `
      <div class="drawer-divider"></div>
      <a href="/login" class="drawer-link" data-close-on-click>
        <span>Log in</span>
        <span class="muted">›</span>
      </a>
      <a href="/register" class="drawer-link" data-close-on-click style="color: var(--brand);">
        <span>Create account</span>
        <span class="muted">›</span>
      </a>
    `}
  `;

  panel.querySelectorAll("[data-close-on-click]").forEach(el =>
    el.addEventListener("click", closeDrawer)
  );
  panel.querySelector("[data-close-drawer]")?.addEventListener("click", closeDrawer);
  panel.querySelector("#drawer-theme-toggle")?.addEventListener("click", toggleTheme);
  panel.querySelector("#drawer-logout")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    const orig = btn.textContent;
    btn.textContent = "Signing out…";
    try {
      await logoutAccount();
    } finally {
      switchUser();
      closeDrawer();
      navigate("/");
      try { btn.textContent = orig; btn.dataset.busy = "0"; } catch {}
    }
  });
}

function openDrawer() {
  const drawer = document.getElementById("nav-drawer");
  if (!drawer) return;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("scroll-lock");
}
function closeDrawer() {
  const drawer = document.getElementById("nav-drawer");
  if (!drawer) return;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("scroll-lock");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function computeHoldingsValue(state) {
  let total = 0;
  for (const [sym, h] of Object.entries(state.holdings || {})) {
    total += Math.round(h.qty * h.avgCostPaise);
  }
  return total;
}

function initials(name) {
  if (!name) return "S";
  const parts = String(name).trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
