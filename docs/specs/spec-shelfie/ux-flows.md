# UX flows

Phone-first, one-handed use in a store or kitchen. Dark and light themes follow the system setting.

## Screens

| Screen | Contents |
|---|---|
| Setup | Setup token, admin username and password, first household name. Shown only when the instance is unconfigured. |
| Sign in | Username and password. |
| Home | Counts (items, expiring soon, expired, shopping), an "Expiring soon" list sorted by date with days-left badges, a large Scan button, a pending-sync indicator. |
| Scan | Camera view with a manual barcode entry link; torch toggle when supported. |
| Add lot | Product preview (name, brand, image), quantity, unit, location, expiry date, notes; date field accepts quick presets (+3d, +1w, +1m). |
| Inventory | Filter by location; search; per-lot actions: use one, use all, edit quantity, move, add to shopping. |
| Shopping | Add item, tick off, delete. |
| Settings | Household name, timezone, warning window, alert hour, alert targets; users (admin). |
| Needs attention | Outbox operations marked `invalid`, each with the reason and a fix or discard action. |

## Key flows

1. **Scan and add:** Home → Scan → barcode read → Add lot (product prefilled) → save → returns to Scan for the next item ("Add another").
2. **Offline add:** same flow; the lot appears with a pending badge; the Scan screen never blocks on network; a banner reads "Offline — changes will sync".
3. **Replay:** on reconnect the pending badge counts down; a toast reports anything that needs attention.
4. **Expiry check:** Home shows the soonest-expiring lots first; each row shows "N days" (singular and plural handled), "today" or "N days overdue" with a color state (red overdue or ≤ 3 days, amber ≤ 7, green otherwise).
5. **Use an item:** Inventory → Use one; the last unit removes the lot with an undo toast.

## States and copy rules

- Cached data shows "Last synced <time>"; unresolved products show "Unidentified"; empty states say what to do next.
- Offline banner is persistent but non-blocking; errors never discard user input.
- Touch targets at least 44px; the Scan button is reachable by thumb.
- Install: an Install control appears when the browser supports it; on iOS it shows Add to Home Screen steps.
