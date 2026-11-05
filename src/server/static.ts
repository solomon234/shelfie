import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function readIfFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

// Serves a built SPA directory. Unknown non-API GET paths fall back to index.html.
export function serveSpa(root: string): MiddlewareHandler {
  const base = resolve(root);
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("Bad request", 400);
    }
    const target = resolve(base, "." + pathname);
    if (target !== base && !target.startsWith(base + sep)) return c.text("Not found", 404);

    let body = pathname.endsWith("/") ? null : await readIfFile(target);
    let file = target;
    if (!body) {
      // A path with an extension that does not exist is a real 404, not an app route.
      if (extname(pathname) && !pathname.endsWith(".html")) return c.text("Not found", 404);
      file = resolve(base, "index.html");
      body = await readIfFile(file);
      if (!body) return c.text("Frontend not built", 404);
    }
    const hashed = pathname.startsWith("/assets/");
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };
}
