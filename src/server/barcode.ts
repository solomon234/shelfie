import type { Ctx } from "./context.ts";
import { HttpError } from "./context.ts";

function checkDigitValid(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

// Returns the canonical form (UPC-A becomes EAN-13 by a leading zero) or null if the code is not a valid GTIN.
export function normalizeBarcode(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (![8, 12, 13].includes(digits.length)) return null;
  if (!checkDigitValid(digits)) return null;
  return digits.length === 12 ? "0" + digits : digits;
}

export function requireBarcode(input: string): string {
  const code = normalizeBarcode(input);
  if (!code) throw new HttpError(400, "That is not a valid UPC/EAN barcode");
  return code;
}

export interface Lookup {
  found: boolean;
  name?: string;
  brand?: string;
  image_url?: string;
}

// Open Food Facts. Any failure degrades to {found:false}; callers fall back to manual entry.
export async function lookupProduct(ctx: Ctx, barcode: string): Promise<Lookup> {
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,brands,image_front_small_url`;
    const res = await ctx.fetch(url, { headers: { "User-Agent": ctx.userAgent }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { found: false };
    const data = (await res.json()) as { status?: number; product?: { product_name?: string; brands?: string; image_front_small_url?: string } };
    const p = data.product;
    const name = p?.product_name?.trim();
    if (data.status !== 1 || !name) return { found: false };
    return {
      found: true,
      name: name.slice(0, 180),
      brand: p?.brands?.split(",")[0]?.trim() || undefined,
      image_url: p?.image_front_small_url?.startsWith("https://") ? p.image_front_small_url : undefined,
    };
  } catch {
    return { found: false };
  }
}

export interface ProductInput {
  barcode?: string | null;
  name?: string | null;
  brand?: string | null;
  image_url?: string | null;
}

const nameKey = (n: string) => n.trim().toLowerCase();

// Finds or creates the product for a lot. Runs before the lot's transaction so no
// network call happens while the write lock is held.
export async function resolveProduct(ctx: Ctx, input: ProductInput): Promise<number> {
  const { db } = ctx;
  const name = input.name?.trim() || null;
  if (input.barcode) {
    const code = requireBarcode(input.barcode);
    const existing = db.prepare("SELECT id, resolved FROM products WHERE barcode = ?").get(code) as { id: number; resolved: number } | undefined;
    if (existing?.resolved === 1) return existing.id;
    const found = name ? ({ found: true, name, brand: input.brand ?? undefined, image_url: input.image_url ?? undefined } as Lookup) : await lookupProduct(ctx, code);
    if (existing) {
      if (found.found) {
        db.prepare("UPDATE products SET name = ?, name_key = ?, brand = ?, image_url = ?, resolved = 1 WHERE id = ?").run(
          found.name!, nameKey(found.name!), found.brand ?? null, found.image_url ?? null, existing.id,
        );
      }
      return existing.id;
    }
    const finalName = found.found ? found.name! : code;
    db.prepare("INSERT OR IGNORE INTO products(barcode,name,name_key,brand,image_url,resolved) VALUES (?,?,?,?,?,?)").run(
      code, finalName, nameKey(finalName), found.brand ?? null, found.image_url ?? null, found.found ? 1 : 0,
    );
    return (db.prepare("SELECT id FROM products WHERE barcode = ?").get(code) as { id: number }).id;
  }
  if (!name) throw new HttpError(400, "name or barcode is required");
  db.prepare("INSERT OR IGNORE INTO products(name,name_key,brand,image_url) VALUES (?,?,?,?)").run(name, nameKey(name), input.brand ?? null, input.image_url ?? null);
  return (db.prepare("SELECT id FROM products WHERE name_key = ? AND barcode IS NULL").get(nameKey(name)) as { id: number }).id;
}
