import { AdminCreateUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

// Use the same pool as sign-in; never accept a pool or invitation destination from the request.
export function invitationPool() {
  const match = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9_-]+)\/?$/.exec(process.env.OIDC_ISSUER || '');
  if (!match) throw new Error('Cognito invitations are not configured');
  return { region: match[1], userPoolId: match[2] };
}

// Avoid retrying a request that may already have delivered an invitation.
export const invitationClient = new CognitoIdentityProviderClient({ region: async () => invitationPool().region, maxAttempts: 1 });

export async function inviteUser(email: string, name?: string | null) {
  const pool = invitationPool();
  await invitationClient.send(new AdminCreateUserCommand({
    UserPoolId: pool.userPoolId,
    Username: email,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      ...(name ? [{ Name: 'name', Value: name }] : []),
    ],
    DesiredDeliveryMediums: ['EMAIL'],
  }));
}
