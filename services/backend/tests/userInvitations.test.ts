import assert from 'node:assert/strict';
import { before, beforeEach, after, test, mock } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

process.env.JWT_SECRET = randomBytes(40).toString('hex');
process.env.AUTH_MODE = 'local';
let server: Server, base: string, created: any[], sent: any[], deleted: string[], role: string;
let failure: string | null, dbFailure: boolean;
const db: any = {
  user: {
    create: async ({ data }: any) => {
      if (dbFailure) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      const user = { id: 'new-user', ...data }; created.push(user); return user;
    },
    delete: async ({ where }: any) => { deleted.push(where.id); },
  },
  auditEvent: { create: async () => ({}) },
};
before(async () => {
  const { invitationClient } = await import('../src/services/userInvitations.js');
  mock.method(invitationClient, 'send', async (command: any) => {
    sent.push(command.input);
    if (failure) throw Object.assign(new Error('PRIVATE_UPSTREAM_ERROR'), { name: failure });
    return { User: { Username: 'idp-subject' } };
  });
  const router = (await import('../src/routes/admin.js')).default;
  const app = express(); app.use(express.json()); app.locals.prisma = db;
  app.use((req: any, _res, next) => { req.user = { id: 'admin', role }; next(); });
  app.use('/admin', router);
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  process.env.AUTH_MODE = 'oidc';
  process.env.OIDC_ISSUER = 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_TestPool';
  created = []; sent = []; deleted = []; role = 'admin'; failure = null; dbFailure = false;
});
after(() => { server.close(); mock.restoreAll(); });
const post = (body: any) => fetch(base + '/admin/users', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
test('SSO create sends an email invitation without an admin-chosen password and preserves the selected role', async () => {
  const response = await post({ email: ' New.User@Example.invalid ', name: 'New User', role: 'auditor', password: 'ignored' });
  assert.equal(response.status, 201);
  assert.equal(created[0].email, 'new.user@example.invalid');
  assert.equal(created[0].passwordHash, null);
  assert.equal(created[0].role, 'auditor');
  assert.equal(created[0].roleManagedLocally, true);
  assert.deepEqual(sent[0], { UserPoolId: 'ap-southeast-2_TestPool', Username: 'new.user@example.invalid',
    UserAttributes: [{ Name: 'email', Value: 'new.user@example.invalid' }, { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: 'New User' }], DesiredDeliveryMediums: ['EMAIL'] });
  assert.equal('passwordHash' in await response.json(), false);
});
test('failed invitation rolls back only the new database record and exposes no upstream details', async () => {
  failure = 'AccessDeniedException';
  const response = await post({ email: 'new@example.invalid' });
  assert.equal(response.status, 502);
  assert.deepEqual(deleted, ['new-user']);
  assert.equal((await response.text()).includes('PRIVATE_UPSTREAM_ERROR'), false);
});
test('an existing Cognito login is not overwritten or resent an invitation', async () => {
  failure = 'UsernameExistsException';
  const response = await post({ email: 'existing@example.invalid' });
  assert.equal(response.status, 409);
  assert.deepEqual(deleted, ['new-user']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].MessageAction, undefined);
});
test('database conflict sends no invitation', async () => {
  dbFailure = true;
  assert.equal((await post({ email: 'existing@example.invalid' })).status, 409);
  assert.equal(sent.length, 0);
});
test('non-admin cannot create users or send invitations', async () => {
  role = 'analyst';
  assert.equal((await post({ email: 'new@example.invalid' })).status, 403);
  assert.equal(created.length, 0); assert.equal(sent.length, 0);
});
test('invalid input or unsupported identity provider creates no database-only account', async () => {
  assert.equal((await post({ email: 'invalid' })).status, 400);
  assert.equal((await post({ email: 'new@example.invalid', role: 'owner' })).status, 400);
  process.env.OIDC_ISSUER = 'https://identity.example.invalid';
  assert.equal((await post({ email: 'new@example.invalid' })).status, 500);
  assert.equal(created.length, 0); assert.equal(sent.length, 0);
});
test('local authentication still requires and hashes a password, without Cognito calls', async () => {
  process.env.AUTH_MODE = 'local';
  assert.equal((await post({ email: 'new@example.invalid' })).status, 400);
  assert.equal((await post({ email: 'new@example.invalid', password: 'synthetic-password-123' })).status, 201);
  assert.equal(await bcrypt.compare('synthetic-password-123', created[0].passwordHash), true);
  assert.equal(sent.length, 0);
});
