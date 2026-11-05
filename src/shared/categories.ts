// Categories describe what an item is for, not where it is. "gear" means emergency and safety supplies.
export const CATEGORIES = ["food", "medicine", "gear", "household"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CategoryInfo {
  label: string;
  dateLabel: string;
  // Consumable items are "used"; the rest are "retired" when they wear out or are replaced.
  consumable: boolean;
  // Quick date presets in days.
  presets: [string, number][];
}

export const CATEGORY_INFO: Record<Category, CategoryInfo> = {
  food: { label: "Food", dateLabel: "Best before", consumable: true, presets: [["+3d", 3], ["+1w", 7], ["+2w", 14], ["+1m", 30], ["+6m", 182]] },
  medicine: { label: "Medicine", dateLabel: "Expires", consumable: true, presets: [["+1m", 30], ["+6m", 182], ["+1y", 365], ["+2y", 730]] },
  gear: { label: "Gear", dateLabel: "Replace by", consumable: false, presets: [["+6m", 182], ["+1y", 365], ["+2y", 730], ["+5y", 1826]] },
  household: { label: "Household", dateLabel: "Best before", consumable: true, presets: [["+1m", 30], ["+6m", 182], ["+1y", 365], ["+2y", 730]] },
};

export const isCategory = (v: unknown): v is Category => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
