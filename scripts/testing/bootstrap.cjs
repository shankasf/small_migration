// Privileged, one-off setup only. No credentials or SQL errors are logged.
const {PrismaClient}=require(process.cwd()+'/node_modules/@prisma/client');
const assert=require('node:assert/strict');
const testUrl=new URL(process.env.TEST_DATABASE_URL);
assert.equal(testUrl.pathname,'/circini_testing');
assert.equal(testUrl.username,'circini_testing');
assert.match(testUrl.password,/^[a-f0-9]{64}$/);
const admin=new PrismaClient();
const test=new PrismaClient({datasources:{db:{url:testUrl.toString()}}});
const testAdminUrl=new URL(process.env.DATABASE_URL);testAdminUrl.pathname='/circini_testing';
const testAdmin=new PrismaClient({datasources:{db:{url:testAdminUrl.toString()}}});
(async()=>{
 const roles=await admin.$queryRawUnsafe("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='circini_testing'");
 if(!roles.length)await admin.$executeRawUnsafe(`CREATE ROLE circini_testing LOGIN PASSWORD '${testUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 12`);
 else assert.ok(!roles[0].rolsuper&&!roles[0].rolcreatedb&&!roles[0].rolcreaterole);
 const memberships=await admin.$queryRawUnsafe("SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='circini_testing'");
 assert.equal(memberships[0].n,0);
 const dbs=await admin.$queryRawUnsafe("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='circini_testing'");
 if(!dbs.length)await admin.$executeRawUnsafe('CREATE DATABASE circini_testing OWNER circini_testing');
 else assert.equal(dbs[0].owner,'circini_testing');
 await admin.$executeRawUnsafe('REVOKE ALL ON DATABASE circini_testing FROM PUBLIC');
 await testAdmin.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
 assert.equal((await test.$queryRawUnsafe('SELECT current_database() AS db'))[0].db,'circini_testing');
 // Check every production table; no production grants are changed.
 const exposed=await admin.$queryRawUnsafe("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND (has_table_privilege('circini_testing',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_schema_privilege('circini_testing',schemaname,'CREATE'))");
 assert.equal(exposed[0].n,0);
 console.log(JSON.stringify({testingBootstrap:'passed',productionTablesAccessible:0}));
})().catch(()=>{console.error('Testing database bootstrap or isolation verification failed');process.exitCode=1}).finally(async()=>{await Promise.all([admin.$disconnect(),test.$disconnect(),testAdmin.$disconnect()])});
