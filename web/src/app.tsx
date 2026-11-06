import { useEffect, useMemo, useState } from "preact/hooks";
import { lazy, Suspense } from "preact/compat";
import { CATEGORIES, CATEGORY_INFO, isCategory, type Category } from "../../src/shared/categories.ts";
import { localParts } from "../../src/shared/dates.ts";
import { ApiError, api, store } from "./api.ts";
import { protectPassword } from "./kdf.ts";
import type { Lot } from "./overlay.ts";
import { disablePush, enablePush, pushState, sendTestPush, type PushState } from "./push.ts";
import {
  daysLeft, discardOp, dismissNotice, enqueue, errMsg, household, invalidOps, lots, pendingCount, reloadMe,
  refresh, selectHousehold, shopping, signIn, signOut, summary, syncNow, toast, useApp, type Household,
} from "./state.ts";

const Scanner = lazy(() => import("./scanner.tsx"));

const UNITS = ["item", "can", "bottle", "box", "bag", "pack", "jar", "lb", "oz", "kg", "g", "L", "ml"];
const val = (e: Event) => (e.target as HTMLInputElement).value;

const catOf = (l: { category?: string }): Category => (isCategory(l.category) ? l.category : "food");
// Non-food categories are named in the row so a headlamp is not mistaken for a snack.
const catTag = (l: { category?: string }) => (catOf(l) === "food" ? "" : `${CATEGORY_INFO[catOf(l)].label} · `);

function expiryBadge(days: number | null, warn: number) {
  if (days === null) return <span class="badge none">No date</span>;
  const cls = days < 0 || days <= warn ? "bad" : days <= 7 ? "warn" : "ok";
  const text = days < 0 ? `${-days} ${-days === 1 ? "day" : "days"} overdue` : days === 0 ? "today" : days === 1 ? "tomorrow" : `${days} days`;
  return <span class={`badge ${cls}`}>{text}</span>;
}

let installEvent: (Event & { prompt(): Promise<void> }) | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e as typeof installEvent;
});
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export function App() {
  const s = useApp();
  if (s.phase === "loading") return <div class="center muted">Loading…</div>;
  if (s.phase === "auth") return <Auth />;
  return <Shell />;
}

function Auth() {
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [f, setF] = useState({ username: "", password: "", token: "", household_name: "Home", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: string) => (e: Event) => setF({ ...f, [k]: val(e) });
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn(mode === "login" ? "/api/login" : "/api/setup", mode === "login" ? { username: f.username, password: f.password } : f);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Cannot reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="auth">
      <h1>Shelfie</h1>
      <p class="muted">{mode === "login" ? "Sign in to your pantry." : "Set up this instance. You need the setup token from the server."}</p>
      <form onSubmit={submit}>
        {mode === "setup" && (
          <label>Setup token<input type="password" value={f.token} onInput={set("token")} required autocomplete="off" /></label>
        )}
        <label>Username<input value={f.username} onInput={set("username")} required minLength={2} autocomplete="username" autocapitalize="none" /></label>
        <label>Password<input type="password" value={f.password} onInput={set("password")} required minLength={mode === "setup" ? 8 : 1} autocomplete={mode === "setup" ? "new-password" : "current-password"} /></label>
        {mode === "setup" && (
          <>
            <label>Household name<input value={f.household_name} onInput={set("household_name")} required /></label>
            <label>Timezone<input value={f.timezone} onInput={set("timezone")} list="tzs" required /></label>
          </>
        )}
        {error && <p class="error" role="alert">{error}</p>}
        <button class="primary" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create admin account"}</button>
      </form>
      <button class="link" onClick={() => { setMode(mode === "login" ? "setup" : "login"); setError(""); }}>
        {mode === "login" ? "First time? Set up this instance" : "Back to sign in"}
      </button>
      <TzList />
    </main>
  );
}

function TzList() {
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      return ["UTC"];
    }
  }, []);
  return <datalist id="tzs">{zones.map((z) => <option value={z} />)}</datalist>;
}

type View = { name: "tab" } | { name: "scan" } | { name: "add"; barcode: string | null; prefill?: { name?: string; brand?: string; image_url?: string; category?: Category }; offline?: boolean };

function Shell() {
  const s = useApp();
  const [tab, setTab] = useState<"home" | "inventory" | "shopping" | "settings">("home");
  const [view, setView] = useState<View>({ name: "tab" });
  const pending = pendingCount(s);
  const h = household(s);

  if (view.name === "scan") return <ScanScreen onClose={() => setView({ name: "tab" })} onResult={(v) => setView(v)} />;
  if (view.name === "add")
    return <AddLot view={view} onClose={() => setView({ name: "tab" })} onAnother={() => setView({ name: "scan" })} />;

  return (
    <div class="shell">
      <header>
        <div class="brand">
          {s.me!.households.length > 1 ? (
            <select aria-label="Household" value={s.householdId ?? ""} onChange={(e) => void selectHousehold(Number(val(e)))}>
              {s.me!.households.map((x) => <option value={x.id}>{x.name}</option>)}
            </select>
          ) : (
            <strong>{h?.name ?? "Shelfie"}</strong>
          )}
        </div>
        <button class={`pill ${!s.online ? "off" : pending ? "pend" : "ok"}`} onClick={() => void syncNow()} aria-label="Sync now">
          {s.syncing ? "Syncing…" : !s.online ? (pending ? `Offline · ${pending} pending` : "Offline") : pending ? `${pending} pending` : "Synced"}
        </button>
      </header>
      {!s.online && <div class="banner">Offline. Changes are saved on this device and will sync when you are back online.</div>}
      <Notices />
      <main>
        {tab === "home" && <Home onScan={() => setView({ name: "scan" })} />}
        {tab === "inventory" && <Inventory onScan={() => setView({ name: "scan" })} />}
        {tab === "shopping" && <Shopping />}
        {tab === "settings" && <Settings />}
      </main>
      <nav>
        {(["home", "inventory", "shopping", "settings"] as const).map((t) => (
          <button class={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>
      {s.toast && <div class="toast" role="status">{s.toast}</div>}
    </div>
  );
}

function Notices() {
  const s = useApp();
  const bad = invalidOps(s);
  if (!s.notices.length && !bad.length) return null;
  return (
    <section class="notices">
      {s.notices.map((n) => (
        <div class="notice"><span>{n.text}</span><button class="link" onClick={() => void dismissNotice(n.id)}>Dismiss</button></div>
      ))}
      {bad.map((o) => (
        <div class="notice attention">
          <span><strong>Needs attention:</strong> {String(o.payload.label ?? o.type)}. {o.error}</span>
          <button class="link" onClick={() => void discardOp(o.seq!)}>Discard</button>
        </div>
      ))}
    </section>
  );
}

function Home({ onScan }: { onScan(): void }) {
  const s = useApp();
  const sum = summary(s);
  const h = household(s);
  return (
    <>
      <div class="tiles">
        <div class="tile"><span>Items</span><strong>{Math.round(sum.items * 100) / 100}</strong></div>
        <div class={`tile ${sum.soon ? "warn" : ""}`}><span>Expiring soon</span><strong>{sum.soon}</strong></div>
        <div class={`tile ${sum.expired ? "bad" : ""}`}><span>Expired</span><strong>{sum.expired}</strong></div>
        <div class="tile"><span>Shopping</span><strong>{sum.shopping}</strong></div>
      </div>
      <button class="primary big" onClick={onScan}>Scan item</button>
      <section class="card">
        <h2>Expiring soon</h2>
        {sum.expiring.length === 0 && <p class="muted">Nothing expiring in the next 14 days.</p>}
        {sum.expiring.map(({ l, d }) => (
          <div class="row">
            <div><strong>{l.name}</strong><small>{catTag(l)}{l.location_name} · {fmtQty(l)}</small></div>
            {expiryBadge(d, h?.expiry_warning_days ?? 3)}
          </div>
        ))}
      </section>
      {s.stale && s.lastSynced && <p class="muted center">Showing data from {new Date(s.lastSynced).toLocaleString()}</p>}
    </>
  );
}

const fmtQty = (l: Pick<Lot, "quantity" | "unit">) => `${Math.round(l.quantity * 100) / 100} ${l.unit}`;

function Inventory({ onScan }: { onScan(): void }) {
  const s = useApp();
  const h = household(s);
  const [loc, setLoc] = useState("");
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | number | null>(null);
  const all = lots(s).filter((l) => (!loc || String(l.location_id) === loc) && (!cat || catOf(l) === cat) && (!q || `${l.name} ${l.brand ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const target = (l: Lot) => (typeof l.id === "number" ? { lot_id: l.id } : { lot_client_id: l.client_id });
  const online = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "You need to be online for that.");
    }
  };
  return (
    <>
      <div class="filters">
        <input type="search" placeholder="Search" value={q} onInput={(e) => setQ(val(e))} />
        <select aria-label="Location" value={loc} onChange={(e) => setLoc(val(e))}>
          <option value="">All locations</option>
          {s.locations.map((x) => <option value={x.id}>{x.name}</option>)}
        </select>
        <select aria-label="Category" value={cat} onChange={(e) => setCat(val(e))}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option value={c}>{CATEGORY_INFO[c].label}</option>)}
        </select>
      </div>
      {all.length === 0 && (
        <p class="muted center">Nothing here yet. <button class="link" onClick={onScan}>Scan an item</button></p>
      )}
      <section class="card flush">
        {all.map((l) => (
          <div class="lot">
            <button class="row tap" onClick={() => setOpen(open === l.id ? null : l.id)} aria-expanded={open === l.id}>
              <div>
                <strong>{l.name}{l.pending && <i class="dot" title="Not synced yet" />}</strong>
                <small>{catTag(l)}{l.resolved ? l.brand ?? "" : "Unidentified until synced"}{l.brand && l.resolved ? " · " : ""}{l.location_name} · {fmtQty(l)}</small>
              </div>
              {expiryBadge(daysLeft(l.expires_on, h), h?.expiry_warning_days ?? 3)}
            </button>
            {open === l.id && (
              <div class="actions">
                <button onClick={() => void enqueue("lot.consume", { ...target(l), amount: 1, label: l.name })}>{CATEGORY_INFO[catOf(l)].consumable ? "Use 1" : "Retire 1"}</button>
                <button onClick={() => void enqueue("lot.consume", { ...target(l), amount: l.quantity, label: l.name })}>{CATEGORY_INFO[catOf(l)].consumable ? "Use all" : "Retire all"}</button>
                <select aria-label="Move to" value="" onChange={(e) => val(e) && void enqueue("lot.move", { ...target(l), location_id: Number(val(e)), label: l.name })}>
                  <option value="">Move to…</option>
                  {s.locations.filter((x) => x.id !== l.location_id).map((x) => <option value={x.id}>{x.name}</option>)}
                </select>
                <button onClick={() => void enqueue("shopping.add", { name: l.name, quantity: 1, unit: l.unit, label: l.name }).then(() => toast("Added to shopping list"))}>Shop</button>
                {typeof l.id === "number" && (
                  <>
                    <button onClick={online(async () => {
                      const v = Number(prompt("Quantity", String(l.quantity)));
                      if (v > 0) await api(`/api/households/${s.householdId}/lots/${l.id}`, { method: "PATCH", body: { quantity: v } });
                    })}>Edit qty</button>
                    <button class="danger" onClick={online(async () => {
                      if (confirm(`Delete ${l.name}?`)) await api(`/api/households/${s.householdId}/lots/${l.id}`, { method: "DELETE" });
                    })}>Delete</button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
    </>
  );
}

function Shopping() {
  const s = useApp();
  const [name, setName] = useState("");
  const items = shopping(s);
  const target = (i: (typeof items)[number]) => (typeof i.id === "number" ? { item_id: i.id } : { item_client_id: i.client_id });
  return (
    <>
      <form class="inline" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { void enqueue("shopping.add", { name: name.trim(), quantity: 1, unit: "item", label: name.trim() }); setName(""); } }}>
        <input placeholder="Add an item" value={name} onInput={(e) => setName(val(e))} aria-label="Item name" />
        <button class="primary">Add</button>
      </form>
      {items.length === 0 && <p class="muted center">Your shopping list is empty.</p>}
      <section class="card flush">
        {items.map((i) => (
          <div class={`row ${i.checked ? "done" : ""}`}>
            <button class="check" aria-label={i.checked ? "Uncheck" : "Check"} onClick={() => void enqueue("shopping.toggle", { ...target(i), label: i.name })}>{i.checked ? "✓" : ""}</button>
            <div class="grow"><strong>{i.name}</strong><small>{i.quantity > 1 || i.unit !== "item" ? fmtQty(i) : ""}</small></div>
            <button class="icon" aria-label={`Remove ${i.name}`} onClick={() => void enqueue("shopping.delete", { ...target(i), label: i.name })}>✕</button>
          </div>
        ))}
      </section>
    </>
  );
}

function ScanScreen({ onClose, onResult }: { onClose(): void; onResult(v: Extract<View, { name: "add" }>): void }) {
  const s = useApp();
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);

  async function resolve(raw: string) {
    setBusy(true);
    try {
      const code = raw.replace(/\D/g, "");
      try {
        const p = await api<{ found: boolean; barcode: string; name?: string; brand?: string; image_url?: string; category?: Category }>(`/api/products/${code}`);
        onResult({ name: "add", barcode: p.barcode, prefill: p.found ? p : undefined });
      } catch (e) {
        if (e instanceof ApiError) return toast(e.message);
        // Offline: use a name we already know for this barcode, else the server names it after syncing.
        const norm = code.length === 12 ? "0" + code : code;
        const known = s.names[norm];
        const knownCat = s.categories[norm];
        onResult({ name: "add", barcode: norm, prefill: known ? { name: known, category: isCategory(knownCat) ? knownCat : undefined } : undefined, offline: true });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="screen">
      <header><button class="link" onClick={onClose}>Cancel</button><strong>Scan</strong><span /></header>
      <Suspense fallback={<p class="muted center">Loading scanner…</p>}>
        <Scanner onCode={(c) => void resolve(c)} />
      </Suspense>
      <form class="inline" onSubmit={(e) => { e.preventDefault(); if (manual) void resolve(manual); }}>
        <input inputMode="numeric" placeholder="Or type the barcode number" value={manual} onInput={(e) => setManual(val(e))} aria-label="Barcode number" />
        <button class="primary" disabled={busy}>Look up</button>
      </form>
      <button class="link center" onClick={() => onResult({ name: "add", barcode: null })}>Add without a barcode</button>
      {s.toast && <div class="toast" role="status">{s.toast}</div>}
    </div>
  );
}

function addDays(n: number, tz: string): string {
  const base = Date.parse(localParts(new Date(), tz).date + "T00:00:00Z");
  return new Date(base + n * 86400_000).toISOString().slice(0, 10);
}

function AddLot({ view, onClose, onAnother }: { view: Extract<View, { name: "add" }>; onClose(): void; onAnother(): void }) {
  const s = useApp();
  const h = household(s);
  const [name, setName] = useState(view.prefill?.name ?? "");
  const [brand, setBrand] = useState(view.prefill?.brand ?? "");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("item");
  const [loc, setLoc] = useState(String(s.locations[0]?.id ?? ""));
  const [exp, setExp] = useState("");
  const [notes, setNotes] = useState("");
  const [category, setCategory] = useState<Category>(view.prefill?.category ?? "food");
  // With no known category, start from the last one used (a preparedness run adds many gear items in a row).
  useEffect(() => {
    if (!view.prefill?.category) void store.kvGet<string>("lastCategory").then((c) => isCategory(c) && setCategory(c));
  }, []);
  const info = CATEGORY_INFO[category];
  const needsName = !view.barcode && !name.trim();
  const unknownOffline = view.barcode && !view.prefill?.name;

  async function save(another: boolean) {
    const quantity = Number(qty);
    if (!(quantity > 0)) return toast("Quantity must be more than zero");
    if (!view.barcode && !name.trim()) return toast("Enter a name");
    const label = name.trim() || view.barcode!;
    await enqueue("lot.add", {
      location_id: Number(loc),
      barcode: view.barcode ?? undefined,
      name: name.trim() || undefined,
      brand: brand.trim() || undefined,
      image_url: view.prefill?.image_url,
      quantity,
      unit,
      category,
      expires_on: exp || undefined,
      notes: notes.trim() || undefined,
      label,
    });
    void store.kvSet("lastCategory", category);
    toast(`Added ${label}`);
    another ? onAnother() : onClose();
  }

  return (
    <div class="screen">
      <header><button class="link" onClick={onClose}>Cancel</button><strong>Add to pantry</strong><span /></header>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); void save(false); }}>
        {view.prefill?.image_url && <img class="thumb" src={view.prefill.image_url} alt="" />}
        {view.barcode && <p class="muted">Barcode {view.barcode}</p>}
        {unknownOffline && (
          <p class="hint">{view.offline ? "You are offline, so the product name will be filled in after syncing." : "Product not found. Enter a name, or leave it blank to try again later."}</p>
        )}
        <div class="chips" role="radiogroup" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button type="button" role="radio" aria-checked={category === c} class={`chip ${category === c ? "on" : ""}`} onClick={() => setCategory(c)}>{CATEGORY_INFO[c].label}</button>
          ))}
        </div>
        <label>Name{!view.barcode && " *"}<input value={name} onInput={(e) => setName(val(e))} required={needsName} placeholder={view.barcode ? "Optional" : "e.g. Apples"} /></label>
        <label>Brand<input value={brand} onInput={(e) => setBrand(val(e))} /></label>
        <div class="two">
          <label>Quantity<input type="number" inputMode="decimal" min="0.01" step="any" value={qty} onInput={(e) => setQty(val(e))} required /></label>
          <label>Unit<select value={unit} onChange={(e) => setUnit(val(e))}>{UNITS.map((u) => <option>{u}</option>)}</select></label>
        </div>
        <label>Location<select value={loc} onChange={(e) => setLoc(val(e))}>{s.locations.map((x) => <option value={x.id}>{x.name}</option>)}</select></label>
        <label>{info.dateLabel}
          <input type="date" value={exp} onInput={(e) => setExp(val(e))} />
        </label>
        <div class="chips">
          {info.presets.map(([t, d]) => (
            <button type="button" class="chip" onClick={() => setExp(addDays(d as number, h?.timezone ?? "UTC"))}>{t}</button>
          ))}
          <button type="button" class="chip" onClick={() => setExp("")}>None</button>
        </div>
        <label>Notes<input value={notes} onInput={(e) => setNotes(val(e))} /></label>
        <button class="primary big">Save</button>
        <button type="button" class="secondary big" onClick={() => void save(true)}>Save and scan another</button>
      </form>
      {s.toast && <div class="toast" role="status">{s.toast}</div>}
    </div>
  );
}

function Settings() {
  const s = useApp();
  const h = household(s);
  const bad = invalidOps(s);
  const [version, setVersion] = useState("");
  useEffect(() => { void api<{ version: string }>("/api/health").then((r) => setVersion(r.version)).catch(() => {}); }, []);
  const install = async () => {
    if (isStandalone()) return toast("Already installed");
    if (installEvent) await installEvent.prompt();
    else toast(isIos() ? "Tap Share, then Add to Home Screen" : "Use your browser menu: Install app");
  };
  return (
    <>
      <Notifications />
      {h?.role === "owner" && <HouseholdSettings h={h} />}
      {s.me!.is_admin && <AdminAccounts />}
      <ChangePassword />
      <section class="card">
        <h2>This device</h2>
        <p class="muted">Signed in as {s.me!.username}. {s.lastSynced ? `Last synced ${new Date(s.lastSynced).toLocaleString()}.` : ""}</p>
        {bad.length > 0 && <p class="hint">{bad.length} change{bad.length === 1 ? "" : "s"} need attention (shown at the top).</p>}
        <div class="buttons">
          <button onClick={() => void syncNow()} disabled={s.syncing}>Sync now</button>
          {!isStandalone() && <button onClick={() => void install()}>Install app</button>}
          <button class="danger" onClick={() => { if (!pendingCount(s) || confirm("There are unsynced changes. Sign out anyway?")) void signOut(); }}>Sign out</button>
        </div>
        {isIos() && !isStandalone() && <p class="muted">On iPhone: tap Share, then Add to Home Screen.</p>}
        <p class="muted">Shelfie {version}</p>
      </section>
      <TzList />
    </>
  );
}

interface AdminUser { id: number; username: string; is_admin: boolean; households: { name: string; role: string }[] }

// Instance admins only: make accounts for other people (each with a household of their own) and extra households for yourself.
function AdminAccounts() {
  const s = useApp();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [reset, setReset] = useState<{ id: number; username: string; password: string } | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [f, setF] = useState({ username: "", password: "", household_name: "" });
  const [mine, setMine] = useState("");
  const load = () => api<AdminUser[]>("/api/admin/users").then(setUsers).catch(() => {});
  useEffect(() => { void load(); }, []);
  async function createAccount(e: Event) {
    e.preventDefault();
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: { username: f.username, password: await protectPassword(f.username, f.password), household_name: f.household_name || undefined, timezone: tz },
      });
      setF({ username: "", password: "", household_name: "" });
      await load();
      toast("Account created");
    } catch (err) {
      toast(errMsg(err));
    }
  }
  async function resetPassword(e: Event) {
    e.preventDefault();
    if (!reset) return;
    try {
      await api(`/api/admin/users/${reset.id}/password`, { method: "POST", body: { password: await protectPassword(reset.username, reset.password) } });
      toast(`Password reset for ${reset.username}. They are signed out everywhere.`);
      setReset(null);
    } catch (err) {
      toast(errMsg(err));
    }
  }
  async function createMine(e: Event) {
    e.preventDefault();
    try {
      await api("/api/households", { method: "POST", body: { name: mine, timezone: tz } });
      setMine("");
      await Promise.all([reloadMe(), load()]);
      toast("Household created");
    } catch (err) {
      toast(errMsg(err));
    }
  }
  return (
    <section class="card">
      <h2>Accounts</h2>
      {users.map((u) => (
        <>
          <div class="row">
            <strong>{u.username}{u.is_admin ? " (admin)" : ""}</strong>
            <small>{u.households.map((h) => `${h.name} (${h.role})`).join(", ") || "no household"}</small>
            {u.id !== s.me!.id && <button type="button" onClick={() => setReset({ id: u.id, username: u.username, password: "" })}>Reset password</button>}
          </div>
          {reset?.id === u.id && (
            <form class="stack" onSubmit={resetPassword}>
              <label>New password for {u.username}<input type="password" value={reset.password} onInput={(e) => setReset({ ...reset, password: val(e) })} required minLength={8} autocomplete="new-password" /></label>
              <div class="buttons"><button>Save</button><button type="button" onClick={() => setReset(null)}>Cancel</button></div>
            </form>
          )}
        </>
      ))}
      <h3>New account</h3>
      <p class="muted">The person gets a household of their own that only they can see. Give them the password; they can change it in Settings.</p>
      <form class="stack" onSubmit={createAccount}>
        <label>Username<input value={f.username} onInput={(e) => setF({ ...f, username: val(e) })} required minLength={2} autocapitalize="none" /></label>
        <label>Password<input type="password" value={f.password} onInput={(e) => setF({ ...f, password: val(e) })} required minLength={8} autocomplete="new-password" /></label>
        <label>Household name (optional)<input value={f.household_name} onInput={(e) => setF({ ...f, household_name: val(e) })} placeholder="Their pantry" /></label>
        <button>Create account</button>
      </form>
      <h3>New household for you</h3>
      <form class="stack" onSubmit={createMine}>
        <label>Name<input value={mine} onInput={(e) => setMine(val(e))} required /></label>
        <button>Create household</button>
      </form>
    </section>
  );
}

function ChangePassword() {
  const s = useApp();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  async function submit(e: Event) {
    e.preventDefault();
    if (f.next !== f.again) return toast("The new passwords do not match");
    setBusy(true);
    try {
      const u = s.me!.username;
      await api("/api/me/password", { method: "POST", body: { current_password: await protectPassword(u, f.current), new_password: await protectPassword(u, f.next) } });
      setF({ current: "", next: "", again: "" });
      toast("Password changed. Other devices are signed out.");
    } catch (err) {
      toast(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="card">
      <h2>Change password</h2>
      <form class="stack" onSubmit={submit}>
        <label>Current password<input type="password" value={f.current} onInput={(e) => setF({ ...f, current: val(e) })} required autocomplete="current-password" /></label>
        <label>New password<input type="password" value={f.next} onInput={(e) => setF({ ...f, next: val(e) })} required minLength={8} autocomplete="new-password" /></label>
        <label>New password again<input type="password" value={f.again} onInput={(e) => setF({ ...f, again: val(e) })} required minLength={8} autocomplete="new-password" /></label>
        <button disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
      </form>
    </section>
  );
}

function Notifications() {
  const [state, setState] = useState<PushState | "checking">("checking");
  const [busy, setBusy] = useState(false);
  const refreshState = () => pushState().then(setState).catch(() => setState("unsupported"));
  useEffect(() => { void refreshState(); }, []);
  const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
      await refreshState();
    }
  };
  return (
    <section class="card">
      <h2>Notifications on this device</h2>
      {state === "checking" && <p class="muted">Checking…</p>}
      {state === "unsupported" && <p class="muted">Not available here. Open the installed app over HTTPS to get expiry alerts as notifications.</p>}
      {state === "denied" && <p class="hint">Notifications are blocked for this site. Allow them in your browser's site settings, then come back.</p>}
      {state === "off" && (
        <>
          <p class="muted">Get an alert when food is about to expire, even when the app is closed.</p>
          <div class="buttons"><button class="primary" disabled={busy} onClick={run(enablePush, "Notifications on")}>Turn on notifications</button></div>
        </>
      )}
      {state === "on" && (
        <>
          <p class="muted">On for this device. Alerts follow your household's alert time.</p>
          <div class="buttons">
            <button disabled={busy} onClick={run(async () => { await sendTestPush(); }, "Test notification sent")}>Send test</button>
            <button disabled={busy} onClick={run(disablePush, "Notifications off")}>Turn off</button>
          </div>
        </>
      )}
    </section>
  );
}

function HouseholdSettings({ h }: { h: Household }) {
  const [f, setF] = useState({ name: h.name, timezone: h.timezone, expiry_warning_days: String(h.expiry_warning_days), alert_hour: String(h.alert_hour), ntfy_url: h.ntfy_url ?? "", webhook_url: h.webhook_url ?? "" });
  const [members, setMembers] = useState<{ id: number; username: string; role: string }[]>([]);
  const [nm, setNm] = useState({ username: "", password: "", role: "member" });
  const set = (k: string) => (e: Event) => setF({ ...f, [k]: val(e) });
  const loadMembers = () => api<typeof members>(`/api/households/${h.id}/members`).then(setMembers).catch(() => {});
  useEffect(() => { void loadMembers(); }, [h.id]);

  async function save(e: Event) {
    e.preventDefault();
    try {
      await api(`/api/households/${h.id}`, {
        method: "PATCH",
        body: { name: f.name, timezone: f.timezone, expiry_warning_days: Number(f.expiry_warning_days), alert_hour: Number(f.alert_hour), ntfy_url: f.ntfy_url, webhook_url: f.webhook_url },
      });
      await reloadMe();
      toast("Saved");
    } catch (err) {
      toast(errMsg(err));
    }
  }
  async function test() {
    try {
      await api(`/api/households/${h.id}/alerts/test`, { method: "POST" });
      toast("Test alert sent");
    } catch (err) {
      toast(errMsg(err));
    }
  }
  async function addMember(e: Event) {
    e.preventDefault();
    try {
      await api(`/api/households/${h.id}/members`, { method: "POST", body: { ...nm, password: await protectPassword(nm.username, nm.password) } });
      setNm({ username: "", password: "", role: "member" });
      await loadMembers();
      toast("Member added");
    } catch (err) {
      toast(errMsg(err));
    }
  }
  return (
    <>
      <section class="card">
        <h2>Household</h2>
        <form class="stack" onSubmit={save}>
          <label>Name<input value={f.name} onInput={set("name")} required /></label>
          <label>Timezone<input value={f.timezone} onInput={set("timezone")} list="tzs" required /></label>
          <div class="two">
            <label>Warn me (days before)<input type="number" min="0" max="60" value={f.expiry_warning_days} onInput={set("expiry_warning_days")} required /></label>
            <label>Alert time (hour)<input type="number" min="0" max="23" value={f.alert_hour} onInput={set("alert_hour")} required /></label>
          </div>
          <label>ntfy topic URL<input type="url" placeholder="https://ntfy.sh/my-pantry" value={f.ntfy_url} onInput={set("ntfy_url")} /></label>
          <label>Webhook URL<input type="url" value={f.webhook_url} onInput={set("webhook_url")} /></label>
          <div class="buttons"><button class="primary">Save</button><button type="button" onClick={() => void test()}>Send test alert</button></div>
        </form>
      </section>
      <section class="card">
        <h2>Members</h2>
        {members.map((m) => <div class="row"><strong>{m.username}</strong><small>{m.role}</small></div>)}
        <form class="stack" onSubmit={addMember}>
          <label>Username<input value={nm.username} onInput={(e) => setNm({ ...nm, username: val(e) })} required autocapitalize="none" /></label>
          <label>Password (for new users)<input type="password" value={nm.password} onInput={(e) => setNm({ ...nm, password: val(e) })} minLength={8} autocomplete="new-password" /></label>
          <label>Role<select value={nm.role} onChange={(e) => setNm({ ...nm, role: val(e) })}><option value="member">Member</option><option value="owner">Owner</option></select></label>
          <button>Add member</button>
        </form>
      </section>
    </>
  );
}
