import { createHash, createPrivateKey, createPublicKey, createSign } from 'crypto';

export function snowflakeKeyPairJwt(account: string, username: string, privateKeyPem: string, passphrase?: string): string {
  const privateKey = createPrivateKey({
    key: privateKeyPem,
    format: 'pem',
    ...(passphrase ? { passphrase } : {}),
  });
  const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const fingerprint = `SHA256:${createHash('sha256').update(publicKeyDer).digest('base64')}`;
  const qualifiedUser = `${account.toUpperCase().replace(/\./g, '-')}.${username.toUpperCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: `${qualifiedUser}.${fingerprint}`,
    sub: qualifiedUser,
    iat: now,
    exp: now + 59 * 60,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).end().sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

