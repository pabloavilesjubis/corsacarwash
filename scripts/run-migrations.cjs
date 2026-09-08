#!/usr/bin/env node
/**
 * CORSA — Migration Runner via Supabase Management API
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

const MISSING = [
  ['SUPABASE_ACCESS_TOKEN', PAT],
  ['SUPABASE_PROJECT_REF', PROJECT_REF],
  ['SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING.length) {
  console.error(`\u274c Missing environment variables: ${MISSING.join(', ')}`);
  console.error('   Set them in your shell or .env.local before running this script.');
  process.exit(1);
}

function execSQL(sql) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query: sql });
    const opts = {
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function checkTable(table) {
  return new Promise((resolve) => {
    const opts = {
      hostname: `${PROJECT_REF}.supabase.co`,
      path: `/rest/v1/${table}?limit=0`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY }
    };
    const req = https.request(opts, res => {
      let buf = ''; res.on('data', d => buf += d);
      res.on('end', () => resolve(res.statusCode !== 404));
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Migrations to check and run — with the sentinel table that proves they ran
const MIGRATIONS = [
  { file: '0015_memberships.sql',  sentinel: 'membership_plans' },
  { file: '0020_procurement.sql',  sentinel: 'suppliers' },
  { file: '0021_inventory.sql',    sentinel: 'inventory_stock' },
  { file: '0023_audit.sql',        sentinel: 'audit_logs' },
];

async function main() {
  console.log('🚀 CORSA Migration Runner — Management API\n');

  // Test API access
  const test = await execSQL('SELECT current_database() as db, now() as ts');
  if (test.status !== 200 && test.status !== 201) {
    console.error('❌ API access failed:', test.status, test.body);
    process.exit(1);
  }
  const parsed = JSON.parse(test.body);
  console.log(`✅ Connected to: ${parsed[0]?.db} @ ${parsed[0]?.ts}\n`);

  for (const m of MIGRATIONS) {
    // Check if already applied
    const exists = await checkTable(m.sentinel);
    if (exists) {
      console.log(`⏭  ${m.file} — already applied (${m.sentinel} exists)`);
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, m.file);
    if (!fs.existsSync(filePath)) {
      console.log(`⚠  ${m.file} — file not found, skipping`);
      continue;
    }

    console.log(`\n▶  Running ${m.file}...`);
    const sql = fs.readFileSync(filePath, 'utf8');

    const result = await execSQL(sql);

    if (result.status === 200 || result.status === 201) {
      console.log(`   ✅ Success`);
    } else {
      let errBody = result.body;
      try { errBody = JSON.stringify(JSON.parse(result.body), null, 2); } catch {}
      console.log(`   ❌ Error (HTTP ${result.status}):`);
      console.log('   ' + errBody.slice(0, 800).split('\n').join('\n   '));

      // Try to continue with other migrations
    }
  }

  // Final state check
  console.log('\n─── Final table status ─────────────────────');
  const allTables = [
    'membership_plans', 'membership_plan_benefits', 'customer_memberships',
    'suppliers', 'purchase_orders', 'accounts_payable',
    'products', 'inventory_stock', 'inventory_movements', 'inventory_locations',
    'audit_logs'
  ];
  for (const t of allTables) {
    const ok = await checkTable(t);
    console.log(`  ${ok ? '✅' : '❌'} ${t}`);
  }
  console.log('\n✅ Done');
}

main().catch(console.error);
