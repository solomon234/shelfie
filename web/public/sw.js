// Shelfie service worker: caches the app shell so the app opens with no connection.
// API data is cached by the app itself (IndexedDB); this worker never touches /api.
const SHELL = "shelfie-shell-v1";
const ASSETS = "shelfie-assets-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      const res = await fetch("/", { cache: "reload" });
      const html = await res.clone().text();
      await shell.put("/", res);
      const urls = [...html.matchAll(/(?:src|href)="(\/[^"/][^"]*)"/g)].map((m) => m[1]);
      const assets = await caches.open(ASSETS);
      await Promise.all(urls.map((u) => assets.add(u).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("shelfie-shell-") && k !== SHELL) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) (await caches.open(SHELL)).put("/", res.clone());
          return res;
        } catch {
          return (await caches.match("/")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit && url.pathname.startsWith("/assets/")) return hit; // hashed, immutable
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(ASSETS)).put(req, res.clone());
        return res;
      } catch {
        return hit ?? Response.error();
      }
    })(),
  );
});

// Web Push: show the alert the server sent, and open the app when it is tapped.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Shelfie", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of open) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
