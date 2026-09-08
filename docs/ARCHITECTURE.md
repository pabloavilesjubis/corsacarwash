# CORSA Carwash — Architecture

## Overview

CORSA Carwash operates on a **React + Supabase + PostgreSQL** architecture.
The backend is entirely Supabase-native: no separate API server is needed.
All security enforcement happens at the database layer (RLS + RPCs).

## Guiding Principles

1. **Security first** — RLS on every table, all mutations via security-definer RPCs
2. **Data immutability** — financial records are never hard-deleted, only voided/cancelled
3. **Concurrency safety** — critical operations use `SELECT FOR UPDATE` or atomic transactions
4. **Auditability** — every critical change writes to `audit_logs`
5. **Multi-org ready** — all tables carry `organization_id` for future SaaS expansion

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Backend | Supabase (PostgreSQL 15) |
| Authentication | Supabase Auth (JWT + bcrypt) |
| Authorization | RBAC (roles/permissions) + RLS |
| Storage | Supabase Storage (private buckets) |
| Realtime | Supabase Realtime (Postgres CDC) |
| Edge Functions | Deno (for integrations needing secrets) |
| Deployment | Vercel (frontend) + Supabase Cloud (backend) |
| Version Control | GitHub |

## Data Flow

```
Browser (React)
    │
    │ HTTPS (Supabase anon key only in frontend)
    ▼
Supabase API Gateway
    │
    ├──► RLS Policies (enforced before any data access)
    │
    ├──► PostgreSQL (via PostgREST for CRUD)
    │
    └──► RPC Functions (security definer, for mutations)
              │
              └──► audit_logs (automatic triggers)
```

## Security Architecture

### Authentication
- Supabase Auth manages all credential handling
- Passwords hashed with bcrypt (Supabase default)
- Sessions stored in memory + Supabase's managed cookie
- JWT expiry: 1 hour with refresh token rotation
- **Self-signup disabled** — only admin invites

### Authorization (RBAC + RLS)
See [RBAC.md](RBAC.md) for full documentation.

Key helper functions:
- `get_my_organization_id()` — organization isolation
- `has_permission(code)` — granular permission check
- `get_accessible_branch_ids()` — branch-level access
- `is_super_admin()` — bypass for admin operations

### API Surface
- **Read operations**: PostgREST + RLS (auto-enforced)
- **Write operations**: RPC functions (`security definer`) — never direct INSERT/UPDATE from client on financial tables

## Environments

| Env | Purpose | Supabase Project |
|-----|---------|-----------------|
| Development | Local development + testing | `corsa-dev` |
| Production | Live CORSA operations | `corsa-prod` |

Seeds ONLY run in Development. Never in Production.

## Modules

```
Foundation    → organizations, branches, profiles, RBAC
CRM           → customers, vehicles, ownership, media
Services      → service_categories, services, service_prices, tax_rates
Operations    → work_orders, workstations, equipment, QC
Payments      → payments, payment_allocations, tips, cash
Memberships   → membership_plans, benefits, usage
Corporate     → fleets, corporate_accounts, CXC
Procurement   → suppliers, purchase_orders, CXP, expenses
Inventory     → products, inventory_stock (ledger-based)
Fiscal        → invoices, fiscal_documents (DTE placeholder)
Analytics     → views, KPI RPCs
Audit         → audit_logs (auto-triggered)
```

## Key Design Decisions

### Why Supabase instead of a custom backend?
Supabase provides PostgreSQL + Auth + Storage + Realtime out of the box. The complexity of running a separate API server is not justified for this use case. Edge Functions handle the few cases requiring server-side secrets (DTE, payments, WhatsApp).

### Why no microservices?
CORSA Carwash is a single-tenant (initially) operational system. The complexity of microservices is not warranted. PostgreSQL RLS provides the security boundaries needed.

### Why RPCs for financial mutations?
Direct INSERT/UPDATE from the client bypasses business rules. Using `security definer` PostgreSQL functions ensures:
- Atomic transactions
- Concurrency safety
- Business rule enforcement
- Consistent audit logging
- Single source of truth for logic

### Why immutable financial records?
Orders, payments, and invoices can never be deleted or retroactively modified. This ensures:
- Audit integrity
- Historical accuracy (price snapshots)
- Accounting compliance
- Fraud detection capability
