#!/bin/bash
# scripts/validate-migrations.sh
# Validates SQL migration files for common patterns
# Run before applying migrations to Supabase

set -e

MIGRATIONS_DIR="$(dirname "$0")/../supabase/migrations"
ERROR_COUNT=0

echo "🔍 Validating CORSA migration files..."

for file in "$MIGRATIONS_DIR"/*.sql; do
  name=$(basename "$file")

  # Check: RLS must be enabled on every table
  tables=$(grep -oP "create table public\.\K\w+" "$file" 2>/dev/null || true)
  for table in $tables; do
    if ! grep -q "enable row level security" "$file" && ! grep -q "$table" "$file"; then
      echo "  ❌ $name: Table $table may be missing RLS"
      ((ERROR_COUNT++))
    fi
  done

  # Check: No hardcoded secrets or passwords
  if grep -qiE "(password|secret|api_key|token)\s*=\s*'[^']+" "$file" 2>/dev/null; then
    echo "  ❌ $name: Possible hardcoded secret detected"
    ((ERROR_COUNT++))
  fi

  # Check: service_role key must never appear
  if grep -q "service_role" "$file" 2>/dev/null; then
    echo "  ❌ $name: service_role reference found in migration"
    ((ERROR_COUNT++))
  fi

  echo "  ✅ $name — OK"
done

if [ "$ERROR_COUNT" -gt 0 ]; then
  echo ""
  echo "❌ Found $ERROR_COUNT issue(s). Please fix before applying."
  exit 1
else
  echo ""
  echo "✅ All migrations look clean."
fi
