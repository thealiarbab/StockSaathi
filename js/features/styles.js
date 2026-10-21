const pendingStylesheets = new Map();

function isLoaded(link) {
  return !!link.sheet;
}

export function ensureStylesheet(id, href, preloadId = "") {
  const existing = document.getElementById(id);
  if (existing?.rel === "stylesheet" && isLoaded(existing)) return Promise.resolve();

  const pending = pendingStylesheets.get(id);
  if (pending) return pending;

  const preload = preloadId ? document.getElementById(preloadId) : null;
  const link = existing?.rel === "stylesheet" ? existing : document.createElement("link");
  if (link !== existing) {
    link.id = id;
    link.rel = "stylesheet";
    link.href = preload?.href || href;
  }

  const promise = new Promise((resolve, reject) => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", () => {
      link.remove();
      reject(new Error(`Failed to load stylesheet: ${link.href}`));
    }, { once: true });
    if (isLoaded(link)) {
      resolve();
    } else if (link !== existing) {
      document.head.appendChild(link);
    }
  }).finally(() => {
    pendingStylesheets.delete(id);
    preload?.remove();
  });

  pendingStylesheets.set(id, promise);
  return promise;
}

export function ensureCoachStyles() {
  return ensureStylesheet("coach-stylesheet", "/css/coach.css");
}
