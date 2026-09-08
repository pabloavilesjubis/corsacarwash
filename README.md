# CORSA Carwash — Sistema Operativo Digital

Sistema empresarial de gestión para CORSA Carwash: lavado, detallado y servicios automotrices.

## Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Backend**: Supabase (PostgreSQL + Auth + RLS + Storage + Realtime + Edge Functions)
- **Deployment**: Vercel + GitHub

## Estructura del Proyecto

```
/
  src/                    # Frontend React/TS
    components/           # Componentes reutilizables
    hooks/               # Custom hooks
    lib/                 # Supabase client, utilidades
    pages/               # Páginas de la aplicación
    types/               # TypeScript types/interfaces
    utils/               # Funciones utilitarias
    integrations/        # Abstracciones para integraciones futuras
  supabase/
    migrations/          # Migraciones SQL (ejecutar en orden)
    functions/           # Edge Functions
    seed/                # Datos de desarrollo
  docs/                  # Documentación técnica
  scripts/               # Scripts de utilidad
  tests/                 # Tests automatizados
```

## Setup — Desarrollo

### 1. Prerrequisitos

- Node.js 20+
- npm 10+
- Supabase CLI: `npm install -g supabase`
- Cuenta en [supabase.com](https://supabase.com)

### 2. Clonar y configurar

```bash
git clone <repo-url>
cd corsa-carwash
npm install
cp .env.example .env.local
# Editar .env.local con tus credenciales de Supabase Development
```

### 3. Configurar Supabase

```bash
# Iniciar Supabase local (requiere Docker)
supabase start

# O conectarse al proyecto remoto
supabase link --project-ref <your-project-ref>
```

### 4. Ejecutar migraciones

```bash
# Local
supabase db reset

# Remoto
supabase db push
```

### 5. Cargar seed de desarrollo

```bash
supabase db seed
# O manualmente:
psql $SUPABASE_DB_URL -f supabase/seed/01_seed_development.sql
```

### 6. Iniciar frontend

```bash
npm run dev
```

## Ambientes

| Ambiente | Proyecto Supabase | URL |
|----------|------------------|-----|
| Development | corsa-dev | http://localhost:5173 |
| Production | corsa-prod | https://app.corsacarwash.com |

> ⚠️ **IMPORTANTE**: Nunca mezclar datos de desarrollo con producción.  
> Ver [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) para instrucciones completas.

## Documentación

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — Arquitectura general del sistema
- [DATABASE.md](docs/DATABASE.md) — Modelo de datos y relaciones
- [ERD.md](docs/ERD.md) — Diagrama entidad-relación
- [RBAC.md](docs/RBAC.md) — Roles, permisos y RLS
- [BUSINESS_RULES.md](docs/BUSINESS_RULES.md) — Reglas de negocio CORSA
- [API.md](docs/API.md) — RPCs y funciones disponibles
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — Guía de deployment
- [PHASE_2_FRONTEND_HANDOFF.md](docs/PHASE_2_FRONTEND_HANDOFF.md) — Handoff para Fase 2

## Seguridad

- Nunca commitear `.env.local` o secretos
- La `service_role` key NUNCA va en el frontend
- Todas las operaciones financieras ocurren via RPC en la base de datos
- RLS activo en todas las tablas de negocio
- Ver [SECURITY.md](docs/SECURITY.md) para política completa

## Fase 1 — Estado

Construyendo la base productiva: backend, base de datos, seguridad y arquitectura.  
El frontend definitivo se construirá en **Fase 2** usando los diseños oficiales de CORSA.
