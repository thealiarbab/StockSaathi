// =============================================================================
// THEMED SELECT — custom dropdown replacing native <select>.
//
// Native <select> lets browsers paint the opened menu themselves, which
// breaks our dark-theme everywhere (ugly white-ish menu in iOS Safari,
// weird flat gradient in Chrome, etc). This component renders a
// theme-consistent popover menu we control completely.
//
// Usage:
//   import { mountThemedSelect } from "../components/themedSelect.js";
//   const node = mountThemedSelect(hostEl, {
//     value: "foo",
//     options: [
//       { value: "foo", label: "Foo",  hint: "detail" },
//       { value: "bar", label: "Bar" },
//       "---",                        // divider
//     ],
//     placeholder: "pick one",
//     onChange: (v) => { ... },
//   });
//
// Keyboard: ↑/↓ navigate · Enter pick · Esc close · typing jumps to first-
// matching option.
// Accessibility: role=combobox/listbox/option + aria-expanded + aria-activedescendant.
// =============================================================================

let uidCounter = 0;

export function mountThemedSelect(hostEl, config) {
  // Callers mount after an async import; if the student has already moved
  // to another page the host is gone (seen 18 Oct 2026 on /register).
  if (!hostEl) return null;
  // Clean up any prior instance on this host. Without this, callers that
  // re-mount on every render (like stocks.js subscribing to quote updates
  // every few seconds) leave zombie <div.ts-menu> nodes attached to
  // document.body on every re-mount. Visible symptom: the dropdown
  // "blinks" as each tick tears down + rebuilds the label, and the body
  // accumulates dozens of invisible menu nodes with leaked scroll listeners.
  if (hostEl._themedSelectInstance && typeof hostEl._themedSelectInstance.destroy === "function") {
    try { hostEl._themedSelectInstance.destroy(); } catch {}
  }
  const uid = "ts-" + (++uidCounter);
  const state = {
    value: config.value ?? null,
    options: normaliseOptions(config.options || []),
    open: false,
    activeIdx: -1,
    placeholder: config.placeholder || "Select…",
    onChange: config.onChange || (() => {}),
  };

  hostEl.innerHTML = "";
  hostEl.classList.add("themed-select");
  hostEl.setAttribute("role", "combobox");
  hostEl.setAttribute("aria-haspopup", "listbox");
  hostEl.setAttribute("aria-expanded", "false");
  hostEl.setAttribute("tabindex", "0");

  const trigger = document.createElement("div");
  trigger.className = "ts-trigger";
  trigger.innerHTML = `<span class="ts-label"></span><span class="ts-chevron" aria-hidden="true">▾</span>`;
  hostEl.appendChild(trigger);

  const menu = document.createElement("div");
  menu.className = "ts-menu";
  menu.setAttribute("role", "listbox");
  menu.id = uid + "-menu";
  menu.style.display = "none";
  document.body.appendChild(menu);
  hostEl.setAttribute("aria-controls", menu.id);

  function renderLabel() {
    const labelEl = trigger.querySelector(".ts-label");
    const match = state.options.find(o => o !== "---" && o.value === state.value);
    if (match) {
      labelEl.textContent = match.label;
      labelEl.classList.remove("placeholder");
    } else {
      labelEl.textContent = state.placeholder;
      labelEl.classList.add("placeholder");
    }
  }
  renderLabel();

  function renderMenu() {
    menu.innerHTML = state.options.map((o, i) => {
      if (o === "---") return `<div class="ts-divider" aria-hidden="true"></div>`;
      const active = i === state.activeIdx ? " ts-active" : "";
      const selected = o.value === state.value;
      const id = `${uid}-opt-${i}`;
      return `<div class="ts-option${active}${selected ? " ts-selected" : ""}" role="option"
                   id="${id}" data-idx="${i}"
                   aria-selected="${selected ? "true" : "false"}">
        <div class="ts-option-main">
          <span class="ts-option-label">${escapeHtml(o.label)}</span>
          ${o.hint ? `<span class="ts-option-hint">${escapeHtml(o.hint)}</span>` : ""}
        </div>
        ${selected ? `<span class="ts-check">✓</span>` : ""}
      </div>`;
    }).join("");
    menu.querySelectorAll(".ts-option").forEach(opt => {
      opt.addEventListener("click", () => {
        const idx = parseInt(opt.dataset.idx, 10);
        setValue(state.options[idx].value);
        closeMenu();
      });
      opt.addEventListener("mouseenter", () => {
        state.activeIdx = parseInt(opt.dataset.idx, 10);
        updateActive();
      });
    });
    const activeId = state.activeIdx >= 0 ? `${uid}-opt-${state.activeIdx}` : "";
    hostEl.setAttribute("aria-activedescendant", activeId);
  }

  function updateActive() {
    menu.querySelectorAll(".ts-option").forEach((el, i) => {
      const idx = parseInt(el.dataset.idx, 10);
      el.classList.toggle("ts-active", idx === state.activeIdx);
    });
    const activeEl = menu.querySelector(".ts-option.ts-active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    const activeId = state.activeIdx >= 0 ? `${uid}-opt-${state.activeIdx}` : "";
    hostEl.setAttribute("aria-activedescendant", activeId);
  }

  function positionMenu() {
    const rect = hostEl.getBoundingClientRect();
    menu.style.display = "block";
    menu.style.position = "fixed";
    // Measure
    const mh = menu.offsetHeight;
    const vh = window.innerHeight;
    const below = vh - rect.bottom;
    const top = below >= Math.min(mh, 320) || below > rect.top
      ? rect.bottom + 4
      : Math.max(8, rect.top - mh - 4);
    menu.style.top = top + "px";
    menu.style.left = rect.left + "px";
    menu.style.minWidth = rect.width + "px";
    menu.style.maxHeight = "min(60vh, 420px)";
  }

  function openMenu() {
    if (state.open) return;
    state.open = true;
    hostEl.setAttribute("aria-expanded", "true");
    state.activeIdx = Math.max(0, state.options.findIndex(o => o !== "---" && o.value === state.value));
    renderMenu();
    positionMenu();
    menu.classList.add("open");
    document.addEventListener("click", handleOutsideClick, true);
    // capture:true catches scrolls on elements that don't bubble scroll — but
    // that means our own menu's inner scroll also triggers this. Filter it so
    // only *outside* scrolls (page scroll, ancestor panel) close the menu.
    window.addEventListener("scroll", onScrollOutside, true);
    window.addEventListener("resize", closeMenu);
  }

  function onScrollOutside(e) {
    if (menu.contains(e.target)) return; // scrolling inside the menu itself — keep it open
    closeMenu();
  }

  function closeMenu() {
    if (!state.open) return;
    state.open = false;
    hostEl.setAttribute("aria-expanded", "false");
    menu.style.display = "none";
    menu.classList.remove("open");
    document.removeEventListener("click", handleOutsideClick, true);
    window.removeEventListener("scroll", onScrollOutside, true);
    window.removeEventListener("resize", closeMenu);
  }

  function handleOutsideClick(e) {
    if (!hostEl.contains(e.target) && !menu.contains(e.target)) closeMenu();
  }

  function setValue(v) {
    const prev = state.value;
    state.value = v;
    renderLabel();
    if (prev !== v) state.onChange(v);
  }

  hostEl.addEventListener("click", (e) => {
    if (menu.contains(e.target)) return;
    if (state.open) closeMenu();
    else openMenu();
  });

  hostEl.addEventListener("keydown", (e) => {
    if (!state.open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      e.preventDefault();
      openMenu();
      return;
    }
    if (!state.open) return;
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.activeIdx = findNextValid(state.activeIdx, +1);
      updateActive();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.activeIdx = findNextValid(state.activeIdx, -1);
      updateActive();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (state.activeIdx >= 0) {
        const opt = state.options[state.activeIdx];
        if (opt !== "---") { setValue(opt.value); closeMenu(); }
      }
      return;
    }
    // Type-to-jump: first option whose label starts with this key
    if (e.key && e.key.length === 1) {
      const idx = state.options.findIndex((o, i) =>
        o !== "---" && i > state.activeIdx && o.label.toLowerCase().startsWith(e.key.toLowerCase())
      );
      const idx2 = idx === -1
        ? state.options.findIndex(o => o !== "---" && o.label.toLowerCase().startsWith(e.key.toLowerCase()))
        : idx;
      if (idx2 >= 0) { state.activeIdx = idx2; updateActive(); }
    }
  });

  function findNextValid(from, dir) {
    const n = state.options.length;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (state.options[i] !== "---") return i;
    }
    return from;
  }

  // Public API. The instance is also stashed on the host element so that
  // mountThemedSelect() on the same host cleans itself up next time (see
  // the re-mount guard at the top of this function).
  const instance = {
    setValue,
    getValue: () => state.value,
    setOptions(next) { state.options = normaliseOptions(next); if (state.open) renderMenu(); },
    destroy() {
      closeMenu();
      menu.remove();
      hostEl.classList.remove("themed-select");
      hostEl.innerHTML = "";
      try { delete hostEl._themedSelectInstance; } catch {}
    },
  };
  try { hostEl._themedSelectInstance = instance; } catch {}
  return instance;
}

function normaliseOptions(arr) {
  return arr.map(o => {
    if (o === "---") return "---";
    if (typeof o === "string") return { value: o, label: o };
    return { value: o.value, label: o.label, hint: o.hint };
  });
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
