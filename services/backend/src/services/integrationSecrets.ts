import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function encryptionKey(value = process.env.INTEGRATION_ENCRYPTION_KEY): Buffer {
  const configured = value?.trim();
  if (!configured) {
    throw new Error('Integration credential encryption is not configured');
  }

  // Accept a 32-byte hex/base64 key, or hash a high-entropy passphrase. This
  // keeps deployment tooling flexible while AES always receives a 256-bit key.
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  const decoded = Buffer.from(configured, 'base64');
  if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === configured.replace(/=+$/, '')) {
    return decoded;
  }
  if (configured.length < 32) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must contain at least 32 characters');
  }
  return createHash('sha256').update(configured, 'utf8').digest();
}

export function integrationEncryptionConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptIntegrationSecrets(value: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptWithKey(value: string, key: Buffer): Record<string, unknown> {
  const [version, ivText, tagText, ciphertextText] = value.split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) {
    throw new Error('Unsupported encrypted integration credential');
  }
  const authenticationTag = Buffer.from(tagText, 'base64url');
  if (authenticationTag.length !== 16) {
    throw new Error('Invalid integration credential authentication tag');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivText, 'base64url'),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(authenticationTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as Record<string, unknown>;
}


export function decryptIntegrationSecrets(value: string): Record<string, unknown> {
  try { return decryptWithKey(value, encryptionKey()); }
  catch {
    if (!process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS) throw new Error('Integration credential could not be decrypted');
    return decryptWithKey(value, encryptionKey(process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS));
  }
}
