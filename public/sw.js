
"use strict";

// NEXUNO Learn - Offline Service Worker

const CACHE = "nexuno-shell-v2";

const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/teacher.html",
  "/manifest.json"
];

// Install and cache the application files.
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Remove old application caches.
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith("nexuno-shell-") && key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Handle application requests.
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache API requests or non-GET requests.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();

          caches.open(CACHE).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) {
          return cached;
        }

        // If an offline page navigation is requested,
        // open the cached application homepage.
        if (request.mode === "navigate") {
          const homepage = await caches.match("/index.html");

          if (homepage) {
            return homepage;
          }
        }

        return new Response("You are offline. This resource is not cached.", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        });
      })
  );
});
