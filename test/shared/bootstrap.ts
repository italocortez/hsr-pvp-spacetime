/**
 * Post-publish bootstrap script. Connects with the server token
 * and calls register_server to create the SYSTEM user and server identity.
 * Run after --clear-database: npx tsx test/shared/bootstrap.ts
 */
import { DbConnection } from '../../src/module_bindings';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(import.meta.dirname || '.', '../../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const token = envContent.match(/SPACETIMEDB_SERVER_TOKEN=(.+)/)?.[1]?.trim() || '';
const uri = envContent.match(/SPACETIMEDB_URI=(.+)/)?.[1]?.trim() || 'wss://maincloud.spacetimedb.com';
const db = envContent.match(/SPACETIMEDB_DB=(.+)/)?.[1]?.trim() || 'hsrpvp-spacetimedb-nextjs-test1';

if (!token) {
  console.error('ERROR: SPACETIMEDB_SERVER_TOKEN not found in .env.local');
  process.exit(1);
}

console.log(`Bootstrapping ${db} on ${uri}...`);

DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(db)
  .withToken(token)
  .withConfirmedReads(false)
  .onConnect(async (conn) => {
    console.log('Connected. Calling registerServer...');
    conn.reducers.registerServer({});
    setTimeout(() => {
      console.log('Bootstrap complete.');
      conn.disconnect();
      process.exit(0);
    }, 4000);
  })
  .onConnectError((_ctx: any, err: any) => {
    console.error('Connection failed:', err);
    process.exit(1);
  })
  .onDisconnect(() => {})
  .build();
