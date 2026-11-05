import type { Context } from "hono";
import { isCategory, type Category } from "../shared/categories.ts";
import { HttpError } from "./context.ts";

export async function readBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  return body as Record<string, unknown>;
}

export function str(o: Record<string, unknown>, key: string, min = 1, max = 200): string {
  const v = o[key];
  if (typeof v !== "string") throw new HttpError(400, `${key} is required`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new HttpError(400, `${key} must be ${min}-${max} characters`);
  return t;
}

export function optStr(o: Record<string, unknown>, key: string, max = 500): string | null {
  const v = o[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${key} is too long`);
  return t || null;
}

export function num(o: Record<string, unknown>, key: string, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${key} must be a number`);
  if (opts.int && !Number.isInteger(v)) throw new HttpError(400, `${key} must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new HttpError(400, `${key} must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new HttpError(400, `${key} must be at most ${opts.max}`);
  return v;
}

export function optNum(o: Record<string, unknown>, key: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | undefined {
  return o[key] === undefined || o[key] === null ? undefined : num(o, key, opts);
}

export function id(v: string | undefined, what = "id"): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, `${what} not found`);
  return n;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isoDate(v: unknown, key: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !ISO_DATE.test(v) || new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, `${key} must be a date like 2026-12-31`);
  }
  return v;
}

export function timezone(v: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
  } catch {
    throw new HttpError(400, "timezone must be an IANA name like America/New_York");
  }
  return v;
}

export function httpUrl(v: string | null, key: string): string | null {
  if (v === null) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new HttpError(400, `${key} must be a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, `${key} must be http or https`);
  return u.toString();
}

export function optCategory(o: Record<string, unknown>, key = "category"): Category | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (!isCategory(v)) throw new HttpError(400, "category must be food, medicine, gear or household");
  return v;
}
