# Architecture diagrams

## Runtime topology

```mermaid
flowchart LR
  Phone["Phone (PWA)\nService worker + IndexedDB outbox"] -- HTTPS via Tailscale / proxy --> App
  subgraph Jetson["Jetson (Docker)"]
    App["shelfie container\nHono + Preact SPA"] --> DB[("SQLite\n/data/shelfie.db (local disk)")]
    App -->|daily check| Alerts["Alert job"]
  end
  App -->|barcode lookup| OFF["Open Food Facts"]
  Alerts --> Ntfy["ntfy / webhook"]
  Ntfy --> Phone
```

## Offline write and replay

```mermaid
sequenceDiagram
  participant U as User
  participant C as Client (PWA)
  participant O as Outbox (IndexedDB)
  participant S as Server
  U->>C: Scan barcode, set expiry
  C->>O: Append lot.add (client_id)
  C-->>U: Shows lot as pending
  Note over C,S: Network returns, or app opens
  C->>S: POST /api/sync { ops }
  S->>S: Apply each op; resolve barcode via Open Food Facts
  S-->>C: results (applied / duplicate / gone / invalid)
  C->>O: Remove applied and duplicate ops
  C->>S: GET inventory
  C-->>U: Updated list, pending count cleared
```

## Expiry alert lifecycle

```mermaid
stateDiagram-v2
  [*] --> Fresh
  Fresh --> Warning: days to expiry <= household window
  Warning --> Expired: expiry date passes
  Warning --> [*]: consumed
  Expired --> [*]: consumed
  note right of Warning: one alert recorded in alert_state
  note right of Expired: one alert recorded in alert_state
```
