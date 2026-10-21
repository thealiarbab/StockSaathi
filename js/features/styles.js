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
    const stylesheetHref = link.href;
    const attach = (target, retriesRemaining) => {
      target.addEventListener("load", resolve, { once: true });
      target.addEventListener("error", () => {
        target.remove();
        if (retriesRemaining > 0) {
          const retry = document.createElement("link");
          retry.id = id;
          retry.rel = "stylesheet";
          retry.href = stylesheetHref;
          attach(retry, retriesRemaining - 1);
          document.head.appendChild(retry);
          return;
        }
        reject(new Error(`Failed to load stylesheet: ${stylesheetHref}`));
      }, { once: true });
      if (isLoaded(target)) resolve();
      else if (target !== existing) document.head.appendChild(target);
    };
    attach(link, 1);
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
