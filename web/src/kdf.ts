import { api } from "./api.ts";

// When the server runs in "client" mode (the Cloudflare Worker, which cannot afford a slow hash per login),
// the browser does the expensive password stretching and sends the result instead of the password.
export const KDF_ITERATIONS = 600_000;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The username is the salt, so the browser can compute this without a round trip that would reveal which users exist.
export async function stretchPassword(username: string, password: string, iterations = KDF_ITERATIONS): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`shelfie:v1:${username.trim().toLowerCase()}`), iterations },
    key,
    256,
  );
  return b64url(new Uint8Array(bits));
}

let mode: Promise<"server" | "client"> | undefined;
const authMode = () =>
  (mode ??= api<{ auth?: string }>("/api/health")
    .then((r) => (r.auth === "client" ? ("client" as const) : ("server" as const)))
    .catch(() => {
      mode = undefined;
      return "server" as const;
    }));

// What to put in the `password` field of /api/login, /api/setup and the add-member form.
export async function protectPassword(username: string, password: string): Promise<string> {
  if (!password) return password;
  return (await authMode()) === "client" ? stretchPassword(username, password) : password;
}
