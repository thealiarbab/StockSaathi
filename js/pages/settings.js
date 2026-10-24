// =============================================================================
// SETTINGS — profile, account & security, appearance, notifications,
// data export, reset / delete. Sections with a sticky jump list.
// =============================================================================

import { getState, subscribe, setSetting, setSettings, resetCurrentPortfolio, switchUser } from "../state.js";
import { logoutAccount, deleteCurrentAccount, updateProfile, changePassword, currentUser } from "../auth/accounts.js";
import { navigate } from "../router.js";
import { toast } from "../components/toast.js";
import { onBackdropClick } from "../components/backdrop.js";

const SECTIONS = [
  ["profile", "Profile"], ["account", "Account & security"], ["appearance", "Appearance"],
  ["notifications", "Notifications"], ["data", "Data & privacy"], ["danger", "Danger zone"], ["about", "About"],
];
const COLORS = ["green", "blue", "purple", "saffron"];
const RISKS = [
  ["cautious", "Cautious", "Protect what I have"],
  ["balanced", "Balanced", "Some ups and downs are fine"],
  ["bold", "Bold", "Happy to ride big swings"],
];

export function renderSettings(main) {
  let dirty = false;   // unsaved profile edits: never re-render over them
  let spy = null;      // section-in-view observer
  render();
  // Re-render only when something this page shows changes. It used to
  // re-render on EVERY state change (a price tick, the order poll), which
  // replaced the inputs and wiped whatever was being typed.
  const shown = (st) => JSON.stringify([st.settings, st.user, st.isAuthed]);
  let last = shown(getState());
  const unsub = subscribe((st) => {
    const now = shown(st);
    if (now === last) return;
    last = now;
    if (dirty) return;
    if (main.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) return;
    render();
  });
  window.addEventListener("ss:navigate", () => { unsub?.(); spy?.disconnect(); }, { once: true });

  function render() {
    const state = getState();
    const user = currentUser();
    const signedIn = !!(user && state.isAuthed !== false);
    const sections = SECTIONS.filter(([id]) => signedIn || !["profile", "account", "notifications", "data", "danger"].includes(id));
    const scrollY = window.scrollY;
    main.innerHTML = `
      <div class="st-page">
        <header class="st-head">
          <h1>Settings</h1>
          <p class="muted">Your profile, sign-in, how StockSaathi looks and what it sends you.</p>
        </header>
        <div class="st-layout">
          <nav class="st-nav" aria-label="Settings sections">
            ${sections.map(([id, label]) => `<a href="#${id}" data-sec="${id}" class="${id === "danger" ? "is-danger" : ""}">${label}</a>`).join("")}
          </nav>
          <div class="st-body">
            ${signedIn ? profileCard(user, state) + accountCard(user) : `<section class="card st-card"><p class="muted">Sign in to edit your profile and account.</p><a class="btn btn-primary" href="/login" style="margin-top: var(--sp-3);">Sign in</a></section>`}
            ${appearanceCard(state)}
            ${signedIn ? `<section class="card st-card" id="notifications">
              <h2 class="st-title">Notifications</h2>
              <p class="st-sub">The bell at the top always has everything. These control what reaches this device and your inbox.</p>
              <div id="notif-settings"><p class="muted text-sm">Loading…</p></div>
            </section>` : ""}
            ${signedIn ? dataCard() + dangerCard() : ""}
            ${aboutCard()}
          </div>
        </div>
      </div>
    `;
    window.scrollTo(0, scrollY);
    wireNav(sections);

    const notifBox = main.querySelector("#notif-settings");
    if (notifBox) { drawNotifSettings(notifBox); drawOrderEmailRow(notifBox); }

    // Appearance
    main.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => {
      const t = b.dataset.theme;
      setSettings(t === "system" ? { themeChosen: false } : { theme: t, themeChosen: true });
    }));
    // Desktop-only; safe-navigated because the row is display:none on mobile.
    main.querySelector("#toggle-coach")?.addEventListener("change", (e) => setSetting("coachPanelOpen", e.target.checked));
    // Hinglish lives on the English/Hinglish switch in the coach and /chat headers.

    if (!signedIn) return;
    wireProfile(user);
    wireAccount(user);
    main.querySelector("#export-btn").addEventListener("click", (e) => exportMyData(e.currentTarget));
    main.querySelector("#reset-pf-btn").addEventListener("click", onReset);
    main.querySelector("#delete-account-btn").addEventListener("click", onDelete);
  }

  // ---- Section nav: jump + highlight the section in view ----------------------
  function wireNav(sections) {
    const links = [...main.querySelectorAll(".st-nav a")];
    links.forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const el = main.querySelector(`#${a.dataset.sec}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });   // offset: .st-card scroll-margin-top
      history.replaceState(history.state, "", `#${a.dataset.sec}`);
    }));
    spy?.disconnect();
    const mark = (id) => links.forEach((a) => {
      a.classList.toggle("is-active", a.dataset.sec === id);
      if (a.dataset.sec === id && window.innerWidth < 900) a.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    spy = new IntersectionObserver((ents) => {
      const vis = ents.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) mark(vis.target.id);
    }, { rootMargin: "-20% 0px -65% 0px" });
    sections.forEach(([id]) => { const el = main.querySelector(`#${id}`); if (el) spy.observe(el); });
    mark(sections[0][0]);
    const want = location.hash.slice(1);
    if (want && main.querySelector(`#${want}`)) setTimeout(() => main.querySelector(`.st-nav a[data-sec="${want}"]`)?.click(), 50);
  }

  // ---- Profile -------------------------------------------------------------------
  function wireProfile(user) {
    const form = main.querySelector("#profile-form");
    const save = main.querySelector("#profile-save");
    const msg = main.querySelector("#profile-msg");
    const read = () => ({
      displayName: form.querySelector("#profile-name").value.trim(),
      school: form.querySelector("#profile-school").value.trim(),
      classCode: form.querySelector("#profile-class").value.trim(),
      city: form.querySelector("#profile-city").value.trim(),
      age: form.querySelector("#profile-age").value.trim(),
      riskProfile: form.querySelector("[name=risk]:checked")?.value || "",
      avatarColor: form.querySelector("[name=avatar]:checked")?.value || "green",
    });
    const initial = JSON.stringify(read());
    const sync = () => {
      const v = read();
      dirty = JSON.stringify(v) !== initial;
      save.disabled = !dirty;
      main.querySelector("#profile-discard").hidden = !dirty;
      const av = main.querySelector("#profile-avatar");
      av.className = `friend-avatar st-avatar ${v.avatarColor}`;
      av.textContent = initials(v.displayName || user.username);
      msg.textContent = "";
    };
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    main.querySelector("#profile-discard").addEventListener("click", () => { dirty = false; render(); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = read();
      if (!v.displayName) { msg.innerHTML = `<span class="error-msg">Display name can't be empty.</span>`; return; }
      const age = v.age === "" ? null : Number(v.age);
      if (age !== null && !(Number.isInteger(age) && age >= 13 && age <= 120)) {
        msg.innerHTML = `<span class="error-msg">Age must be a whole number from 13 to 120.</span>`; return;
      }
      save.disabled = true; save.textContent = "Saving…";
      try {
        // Awaited: it said "Profile saved." before the save had run, even
        // when it then failed.
        await updateProfile({
          displayName: v.displayName, school: v.school || null, classCode: v.classCode || null,
          city: v.city || null, age, riskProfile: v.riskProfile || null, avatarColor: v.avatarColor,
        });
        dirty = false;
        toast({ kind: "success", message: "Profile saved." });
        render();
      } catch (err) {
        save.disabled = false; save.textContent = "Save changes";
        msg.innerHTML = `<span class="error-msg">Couldn't save: ${escapeHtml(err.message)}</span>`;
      }
    });
  }

  // ---- Account & security ------------------------------------------------------
  function wireAccount(user) {
    main.querySelector("#logout-btn2").addEventListener("click", (e) => signOut(e.currentTarget, "local"));
    main.querySelector("#logout-all-btn").addEventListener("click", async (e) => {
      const ok = await confirmDialog({
        title: "Sign out everywhere?", icon: "warn",
        body: "<p>Every phone, tablet and computer signed in to this account is signed out, this one included. Use this if you signed in on a school or friend's computer and forgot to sign out.</p>",
        confirm: "Sign out everywhere",
      });
      if (ok) signOut(e.currentTarget, "global");
    });
    const pwForm = main.querySelector("#pw-form");
    pwForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cur = pwForm.querySelector("#pw-cur")?.value || "";
      const nxt = pwForm.querySelector("#pw-new").value;
      const rep = pwForm.querySelector("#pw-new2").value;
      const msg = main.querySelector("#pw-msg");
      const btn = pwForm.querySelector("button[type=submit]");
      if (user.hasPassword !== false && !cur) { msg.innerHTML = `<div class="error-msg">Enter your current password.</div>`; return; }
      if (nxt.length < 8) { msg.innerHTML = `<div class="error-msg">New password must be at least 8 characters.</div>`; return; }
      if (nxt !== rep) { msg.innerHTML = `<div class="error-msg">The two new passwords don't match.</div>`; return; }
      btn.disabled = true; btn.textContent = "Updating…";
      try {
        await changePassword({ currentPassword: cur, newPassword: nxt });
        pwForm.reset();
        msg.innerHTML = `<div class="success-msg">Password changed.</div>`;
      } catch (err) { msg.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
      btn.disabled = false; btn.textContent = user.hasPassword === false ? "Set password" : "Update password";
    });
    main.querySelectorAll("[data-reveal]").forEach((b) => b.addEventListener("click", () => {
      const inp = main.querySelector(`#${b.dataset.reveal}`);
      inp.type = inp.type === "password" ? "text" : "password";
      b.textContent = inp.type === "password" ? "Show" : "Hide";
    }));
  }

  async function signOut(btn, scope) {
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    btn.textContent = "Signing out…";
    try {
      if (scope === "global") {
        const { sb } = await import("../db/supabase.js");
        const client = await sb();
        try { await client?.auth.signOut({ scope: "global" }); } catch {}
      }
      await logoutAccount();
    } finally {
      switchUser();
      navigate("/");
    }
  }

  // ---- Danger zone -------------------------------------------------------------
  async function onReset(e) {
    const btn = e.currentTarget;
    const ok = await confirmDialog({
      title: "Reset your portfolio?", icon: "warn",
      body: "<p>Your cash goes back to the starting amount. Your holdings, trades, open orders and coach chats are cleared.</p><p>Your account, username and settings stay.</p>",
      confirm: "Reset portfolio", danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = "Resetting…";
    try {
      // Supabase-mode: hit the server RPC so the DB is the source of truth.
      // Without this, a user in server-mode would reset locally but the next
      // loadAllFromDb would restore their stale ₹3,130 Reliance position.
      const { sb } = await import("../db/supabase.js");
      const client = await sb();
      if (client) {
        const { data: s } = await client.auth.getSession();
        if (s?.session?.access_token) {
          const { error } = await client.rpc("reset_my_portfolio");
          if (error) throw new Error(error.message);
        }
      }
      resetCurrentPortfolio();
      // Also nuke persisted quote cache so the page paints fresh from Yahoo,
      // not from some ancient localStorage entry.
      try {
        localStorage.removeItem("ss.quotes.v3");
        localStorage.removeItem("ss.quotes.v2");
        localStorage.removeItem("ss.quotes.v1");
        localStorage.removeItem("ss.coachchat.v1");
        localStorage.removeItem("ss.chatlog.v1");
      } catch {}
      toast({ kind: "success", message: "Portfolio reset. Fresh start!" });
    } catch (err) {
      toast({ kind: "error", message: "Reset failed: " + (err.message || err) });
    } finally {
      btn.disabled = false;
      btn.textContent = "Reset portfolio";
    }
  }

  async function onDelete(e) {
    const btn = e.currentTarget;
    const ok = await confirmDialog({
      title: "Delete your account?", icon: "danger",
      body: "<p>This permanently deletes your StockSaathi account: your login, portfolio, trades, watchlist, coach chats and activity.</p><p><b>It cannot be undone.</b> If you might want your history, download your data first.</p>",
      confirm: "Delete my account", danger: true, typeToConfirm: "DELETE",
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await deleteCurrentAccount();
    } catch (err) {
      toast({ kind: "error", message: err.message, duration: 10000 });
      btn.disabled = false;
      btn.textContent = "Delete account";
      return;
    }
    toast({ kind: "success", message: "Your account and its data have been deleted." });
    switchUser();
    navigate("/");
  }
}

// ---- Cards ---------------------------------------------------------------------

function profileCard(user, state) {
  const color = COLORS.includes(user.avatarColor) ? user.avatarColor : "green";
  const risk = user.riskProfile || state.user.riskProfile || "";
  return `<section class="card st-card" id="profile">
    <h2 class="st-title">Profile</h2>
    <p class="st-sub">How you show up on leaderboards and to friends. School and class put you on your class board.</p>
    <form id="profile-form" novalidate>
      <div class="st-id">
        <div id="profile-avatar" class="friend-avatar st-avatar ${color}">${escapeHtml(initials(user.displayName || user.username))}</div>
        <div class="st-id-text">
          <div class="st-name">${escapeHtml(user.displayName || user.username)}</div>
          <div class="dim text-xs">@${escapeHtml(user.username)}</div>
          <div class="st-swatches" role="radiogroup" aria-label="Avatar colour">
            ${COLORS.map((c) => `<label class="st-swatch ${c}" title="${c[0].toUpperCase() + c.slice(1)}"><input type="radio" name="avatar" value="${c}" ${c === color ? "checked" : ""} aria-label="${c}" /><span></span></label>`).join("")}
          </div>
        </div>
      </div>
      <div class="st-grid">
        <div class="field st-wide"><label class="label" for="profile-name">Display name</label>
          <input class="input" id="profile-name" maxlength="40" value="${escapeAttr(user.displayName || "")}" /></div>
        <div class="field"><label class="label" for="profile-school">School <span class="dim">(optional)</span></label>
          <input class="input" id="profile-school" maxlength="80" value="${escapeAttr(user.school ?? state.user.school ?? "")}" /></div>
        <div class="field"><label class="label" for="profile-class">Class code <span class="dim">(optional)</span></label>
          <input class="input" id="profile-class" maxlength="20" placeholder="From your teacher" value="${escapeAttr(user.classCode ?? state.user.classCode ?? "")}" /></div>
        <div class="field"><label class="label" for="profile-city">City <span class="dim">(optional)</span></label>
          <input class="input" id="profile-city" maxlength="60" value="${escapeAttr(user.city || "")}" /></div>
        <div class="field"><label class="label" for="profile-age">Age</label>
          <input class="input" id="profile-age" type="number" inputmode="numeric" min="13" max="120" value="${escapeAttr(user.age ?? state.user.age ?? "")}" /></div>
      </div>
      <fieldset class="st-risk">
        <legend class="label">Risk style <span class="dim">· Saathi tunes its coaching to this</span></legend>
        <div class="st-seg">
          ${RISKS.map(([v, l, d]) => `<label><input type="radio" name="risk" value="${v}" ${risk === v ? "checked" : ""} /><span><b>${l}</b><small>${d}</small></span></label>`).join("")}
        </div>
      </fieldset>
      <div class="st-actions">
        <button type="submit" class="btn btn-primary" id="profile-save" disabled>Save changes</button>
        <button type="button" class="btn btn-ghost" id="profile-discard" hidden>Discard</button>
        <span id="profile-msg" class="text-sm" aria-live="polite"></span>
      </div>
    </form>
  </section>`;
}

function accountCard(user) {
  const hasPw = user.hasPassword !== false;
  const pwField = (id, label, auto) => `<div class="field"><label class="label" for="${id}">${label}</label>
    <div class="st-pw"><input class="input" id="${id}" type="password" autocomplete="${auto}" /><button type="button" class="st-reveal" data-reveal="${id}">Show</button></div></div>`;
  return `<section class="card st-card" id="account">
    <h2 class="st-title">Account &amp; security</h2>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">Email</div><div class="desc">${escapeHtml(user.email || "")}</div></div>
    </div>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">Username</div><div class="desc">@${escapeHtml(user.username)} · friends find you by this</div></div>
    </div>
    ${user.createdAt ? `<div class="settings-row"><div class="label-wrap"><div class="title">Member since</div><div class="desc">${new Date(user.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</div></div></div>` : ""}

    <h3 class="st-h3">${hasPw ? "Change password" : "Set a password"}</h3>
    ${hasPw ? "" : `<p class="st-sub">You sign in with Google. Set a password to also sign in with your email.</p>`}
    <form id="pw-form" class="st-pwgrid" novalidate>
      ${hasPw ? pwField("pw-cur", "Current password", "current-password") : ""}
      ${pwField("pw-new", "New password", "new-password")}
      ${pwField("pw-new2", "Repeat new password", "new-password")}
      <div class="st-actions"><button type="submit" class="btn btn-outline">${hasPw ? "Update password" : "Set password"}</button></div>
      <div id="pw-msg" aria-live="polite"></div>
    </form>

    <h3 class="st-h3">Sessions</h3>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">Sign out</div><div class="desc">Sign out of this device.</div></div>
      <button class="btn btn-ghost btn-sm" id="logout-btn2">Sign out</button>
    </div>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">Sign out everywhere</div><div class="desc">Every device signed in to this account, including school or friends' computers.</div></div>
      <button class="btn btn-outline btn-sm" id="logout-all-btn">Sign out everywhere</button>
    </div>
  </section>`;
}

function appearanceCard(state) {
  const t = !state.settings.themeChosen ? "system" : state.settings.theme;
  return `<section class="card st-card" id="appearance">
    <h2 class="st-title">Appearance</h2>
    <div class="settings-row st-stack">
      <div class="label-wrap"><div class="title">Theme</div><div class="desc">System follows your phone or computer.</div></div>
      <div class="st-themes" role="radiogroup" aria-label="Theme">
        ${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => `
          <button type="button" role="radio" aria-checked="${t === v}" class="st-theme ${t === v ? "is-on" : ""}" data-theme="${v}">
            <span class="st-theme-art st-art-${v}"><i></i><i></i></span>${l}</button>`).join("")}
      </div>
    </div>
    <div class="settings-row" data-desktop-only>
      <div class="label-wrap"><div class="title">Coach panel docked</div><div class="desc">Pin the coach as a right-hand rail on wide screens. On phones the coach opens from the chat button in the corner.</div></div>
      <label class="switch"><input type="checkbox" id="toggle-coach" ${state.settings.coachPanelOpen ? "checked" : ""} /><span class="slider"></span></label>
    </div>
  </section>`;
}

function dataCard() {
  return `<section class="card st-card" id="data">
    <h2 class="st-title">Data &amp; privacy</h2>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">Download my data</div><div class="desc">Your profile, trades, holdings, orders, watchlist, coach chats and notifications in one JSON file.</div></div>
      <button class="btn btn-outline btn-sm" id="export-btn">Download</button>
    </div>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">What we keep and why</div><div class="desc">Read the privacy policy, or write to us to correct or erase anything.</div></div>
      <div class="flex gap-2 wrap"><a href="/privacy" class="btn btn-ghost btn-sm">Privacy policy</a><a href="/grievance" class="btn btn-ghost btn-sm">Contact</a></div>
    </div>
  </section>`;
}

function dangerCard() {
  return `<section class="card st-card st-danger" id="danger">
    <h2 class="st-title">Danger zone</h2>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">Reset portfolio</div><div class="desc">Start again with fresh virtual cash. Clears trades, holdings, orders and coach chats; keeps your account.</div></div>
      <button class="btn btn-outline st-warn-btn" id="reset-pf-btn">Reset portfolio</button>
    </div>
    <div class="settings-row">
      <div class="label-wrap"><div class="title">Delete account</div><div class="desc">Permanently delete your account and everything in it. Cannot be undone.</div></div>
      <button class="btn btn-danger" id="delete-account-btn">Delete account</button>
    </div>
  </section>`;
}

function aboutCard() {
  return `<section class="card st-card st-about" id="about">
    <h2 class="st-title">About &amp; legal</h2>
    <p class="text-sm" style="line-height: 1.7;"><strong>StockSaathi</strong> — an AI-coached investment simulator for Indian teens. Real stock data, virtual money, behavioural coach. Zero setup — just sign up and start.</p>
    <p class="dim text-xs" style="line-height: 1.7; margin-top: var(--sp-3);">
      <strong style="color: var(--text-muted);">Educational paper-trading simulator · Virtual money only.</strong>
      All trades and portfolios are simulated — no real securities
      are bought, sold, or held. StockSaathi is
      <strong style="color: var(--text-muted);">not a SEBI-registered broker, investment
      adviser, research analyst, or portfolio manager</strong>, and is not affiliated with
      SEBI, NSE, BSE, or any broker. Nothing on this site is investment advice or a
      recommendation to buy or sell any security. Users are not covered by SEBI's investor
      protection or grievance-redressal mechanisms for any activity on this app. Past
      performance does not guarantee future returns.
    </p>
    <p class="dim text-xs" style="line-height: 1.7; margin-top: var(--sp-2);">
      Price data is sourced from public feeds (Yahoo Finance, CoinGecko, AMFI/MFAPI) and
      shown for educational illustration only. StockSaathi does not hold an exchange data
      licence. Coach commentary is generated by an AI model and may contain errors — treat
      it as behavioural reflection, not guidance.
    </p>
    <div class="flex gap-2" style="margin-top: var(--sp-4); flex-wrap: wrap;">
      <a href="/privacy" class="btn btn-ghost btn-sm">Privacy Policy</a>
      <a href="/terms" class="btn btn-ghost btn-sm">Terms of Use</a>
      <a href="/grievance" class="btn btn-ghost btn-sm">Grievance contact</a>
    </div>
  </section>`;
}

// ---- In-page confirm (replaces prompt()/confirm()) -----------------------------
function confirmDialog({ title, body, confirm, danger = false, icon = "warn", typeToConfirm = "" }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="st-dlg-t">
      <div class="modal-head"><div class="modal-icon ${icon}">!</div><h2 id="st-dlg-t">${escapeHtml(title)}</h2></div>
      <div class="modal-body">${body}
        ${typeToConfirm ? `<label class="label" for="st-dlg-in" style="margin-top: var(--sp-4); display:block;">Type <b>${typeToConfirm}</b> to confirm</label>
        <input class="input" id="st-dlg-in" autocomplete="off" autocapitalize="characters" spellcheck="false" />` : ""}
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-act="no">Cancel</button>
        <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="yes" ${typeToConfirm ? "disabled" : ""}>${escapeHtml(confirm)}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const yes = overlay.querySelector("[data-act=yes]");
    const input = overlay.querySelector("#st-dlg-in");
    const done = (v) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      try { prevFocus?.focus?.(); } catch {}
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      if (e.key === "Enter" && !yes.disabled && (!input || document.activeElement === input)) { e.preventDefault(); done(true); }
    };
    document.addEventListener("keydown", onKey, true);
    input?.addEventListener("input", () => { yes.disabled = input.value.trim().toUpperCase() !== typeToConfirm; });
    overlay.querySelector("[data-act=no]").addEventListener("click", () => done(false));
    yes.addEventListener("click", () => done(true));
    onBackdropClick(overlay, () => done(false));
    (input || overlay.querySelector("[data-act=no]")).focus();
  });
}

// ---- Download my data ------------------------------------------------------------
// Every query filters on the caller's id as well as relying on RLS, so a table
// that is readable more widely (leaderboards) still only exports this user.
const EXPORT_TABLES = [
  ["portfolios", "user_id"], ["holdings", "user_id"], ["transactions", "user_id"],
  ["limit_orders", "user_id"], ["watchlist", "user_id"], ["portfolio_history", "user_id"],
  ["chat_threads", "user_id"], ["chat_projects", "user_id"], ["coach_messages", "user_id"],
  ["chat_feedback", "user_id"], ["chat_shares", "user_id"], ["notifications", "user_id"],
  ["user_notices", "user_id"],
];
async function exportMyData(btn) {
  btn.disabled = true; btn.textContent = "Preparing…";
  try {
    const { sb } = await import("../db/supabase.js");
    const client = await sb();
    const uid = (await client?.auth.getSession())?.data?.session?.user?.id;
    if (!uid) throw new Error("Sign in again first.");
    const out = { exported_at: new Date().toISOString(), app: "StockSaathi", note: "Virtual money only. All amounts in paise unless a column says otherwise." };
    const { data: profile } = await client.from("profiles").select("*").eq("id", uid).maybeSingle();
    out.profile = profile;
    const results = await Promise.all(EXPORT_TABLES.map(async ([t, col]) => {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await client.from(t).select("*").eq(col, uid).range(from, from + 999);
        if (error) return [t, { error: error.message }];
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return [t, rows];
    }));
    for (const [t, rows] of results) out[t] = rows;
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `stocksaathi-${profile?.username || "my-data"}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast({ kind: "success", message: "Your data is downloading." });
  } catch (err) {
    toast({ kind: "error", message: `Couldn't export: ${err?.message || err}` });
  }
  btn.disabled = false; btn.textContent = "Download";
}

function initials(n) {
  if (!n) return "SS";
  const p = String(n).trim().split(/\s+/);
  return (p[0][0] + (p[1]?.[0] || "")).toUpperCase();
}
function escapeAttr(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }

// ---- Notifications (owner preview; features/notifications.js) -----------------
// Push is per device: this lists what THIS phone or browser receives. The bell
// inbox always has everything.
async function drawNotifSettings(box) {
  const N = await import("../features/notifications.js");
  const state = await N.pushState();
  const cats = state === "on" ? await N.pushCategories() : [];
  if (!box.isConnected) return;
  const head = state === "unsupported"
    ? `<p class="muted text-sm">This browser can't receive push alerts. The bell at the top still shows everything.</p>`
    : state === "blocked"
    ? `<p class="muted text-sm">Alerts are blocked for this site. Allow notifications in your browser's site settings, then come back here.</p>`
    : N.needsHomeScreen()
    ? `<p class="muted text-sm">On iPhone and iPad, alerts only work in the app added to your Home Screen: tap Share, then "Add to Home Screen", and open StockSaathi from there.</p>`
    : `<div class="settings-row">
        <div class="label-wrap"><div class="title">Alerts on this device</div><div class="desc">Order fills and other updates, even with the app closed. Nothing is sent between 10 pm and 7 am; those arrive at 7.</div></div>
        <label class="switch"><input type="checkbox" id="push-toggle" ${state === "on" ? "checked" : ""} /><span class="slider"></span></label>
      </div>`;
  box.innerHTML = head + (state === "on" ? N.CATEGORIES.map((c) => `
      <div class="settings-row settings-sub">
        <div class="label-wrap"><div class="title">${c.label}</div><div class="desc">${c.hint}</div></div>
        <label class="switch"><input type="checkbox" data-cat="${c.key}" ${cats.includes(c.key) ? "checked" : ""} /><span class="slider"></span></label>
      </div>`).join("") : "");
  box.querySelector("#push-toggle")?.addEventListener("change", async (e) => {
    e.target.disabled = true;
    try {
      const st = e.target.checked ? await N.enablePush() : await N.disablePush();
      if (e.target.checked && st !== "on") toast({ kind: "info", message: st === "blocked" ? "Notifications are blocked for this site in your browser settings." : "Alerts weren't turned on." });
    } catch (err) { toast({ kind: "error", message: `Couldn't change alerts: ${err?.message || err}` }); }
    drawNotifSettings(box);
  });
  box.querySelectorAll("[data-cat]").forEach((el) => el.addEventListener("change", async () => {
    const on = [...box.querySelectorAll("[data-cat]")].filter((x) => x.checked).map((x) => x.dataset.cat);
    try { await N.setPushCategories(on); } catch (err) { toast({ kind: "error", message: `Couldn't save: ${err?.message || err}` }); }
  }));
}

// Order emails (handlers/fill-email.py): sent only when push didn't reach the
// user, so this switch stays on the page whatever the device can do.
async function drawOrderEmailRow(box) {
  let client, on = true;
  try {
    client = await (await import("../db/supabase.js")).sb();
    const { data } = await client.from("profiles").select("order_emails").maybeSingle();
    if (data && data.order_emails === false) on = false;
  } catch {}
  if (!box.isConnected || !client) return;
  const row = document.createElement("div");
  row.className = "settings-row";
  row.innerHTML = `
    <div class="label-wrap"><div class="title">Email me when an order fills</div><div class="desc">Only when alerts on this device didn't already tell you.</div></div>
    <label class="switch"><input type="checkbox" id="order-email-toggle" ${on ? "checked" : ""} /><span class="slider"></span></label>`;
  box.after(row);
  row.querySelector("input").addEventListener("change", async (e) => {
    const v = e.target.checked;
    e.target.disabled = true;
    try {
      const uid = (await client.auth.getSession()).data.session?.user?.id;
      const { error } = await client.from("profiles").update({ order_emails: v }).eq("id", uid);
      if (error) throw error;
      toast({ kind: "success", message: v ? "Order emails on." : "Order emails off." });
    } catch (err) {
      e.target.checked = !v;
      toast({ kind: "error", message: `Couldn't save: ${err?.message || err}` });
    }
    e.target.disabled = false;
  });
}
