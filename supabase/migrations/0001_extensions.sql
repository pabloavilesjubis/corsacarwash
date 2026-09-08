-- ============================================================
-- Migration: 0001_extensions.sql
-- Description: Enable required PostgreSQL extensions
-- ============================================================

-- UUID generation
create extension if not exists "uuid-ossp";

-- Cryptographic functions
create extension if not exists "pgcrypto";

-- Trigram similarity search (for fuzzy search on names, plates, etc.)
create extension if not exists "pg_trgm";

-- Unaccent for normalized text search
create extension if not exists "unaccent";
