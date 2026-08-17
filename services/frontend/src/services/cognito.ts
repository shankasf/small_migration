import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
  IAuthenticationCallback,
} from 'amazon-cognito-identity-js';
import { OidcConfig } from './oidc';

/**
 * One step of the embedded Cognito sign-in flow. The page drives the flow by
 * awaiting a Step, rendering the matching form, and calling the continuation
 * on the step object — which resolves to the next Step (or 'done').
 */
export type Step =
  | { kind: 'done'; idToken: string }
  | { kind: 'newPasswordRequired'; complete: (newPassword: string) => Promise<Step> }
  | {
      kind: 'mfaSetup';
      secret: string;
      otpauthUrl: string;
      verify: (code: string) => Promise<Step>;
    }
  | { kind: 'totpRequired'; submit: (code: string) => Promise<Step> };

let pool: CognitoUserPool | null = null;
let poolStorage: Storage | null = null;

// In-memory storage for the Cognito SDK: without it the SDK caches the
// id/access/refresh token set in localStorage on every successful auth,
// where it would outlive our own logout (clearAuth removes only the app's
// token). The app manages its session itself, so nothing may persist here.
function memoryStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  };
}

/** Build the user pool from the backend auth config (pool id = last segment of the authority URL). */
export function initPool(cfg: OidcConfig): void {
  const userPoolId = cfg.authority.substring(cfg.authority.lastIndexOf('/') + 1);
  poolStorage = memoryStorage();
  pool = new CognitoUserPool({
    UserPoolId: userPoolId,
    ClientId: cfg.clientId,
    Storage: poolStorage,
  });
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  const message = (err as { message?: string } | null)?.message;
  return new Error(message || 'Sign-in failed — please try again');
}

/**
 * Start a USER_SRP_AUTH sign-in. Cognito may interleave challenges
 * (new password, TOTP setup, TOTP code); every continuation funnels back
 * through ONE shared callbacks object, which resolves whichever Step promise
 * is currently pending.
 */
export function signIn(email: string, password: string): Promise<Step> {
  if (!pool) {
    return Promise.reject(new Error('Sign-in is not configured — reload the page and try again'));
  }

  // CognitoUser takes its OWN Storage — it does not inherit the pool's, and
  // without it the SDK caches the whole token set (refresh token included)
  // in localStorage, outliving our logout.
  const cognitoUser = new CognitoUser({ Username: email, Pool: pool, Storage: poolStorage! });

  // The resolve/reject of the *current* pending Step promise. The shared
  // callbacks below always settle these; each continuation re-arms them
  // via nextStep() before poking Cognito again.
  let resolveStep: (step: Step) => void = () => {};
  let rejectStep: (err: Error) => void = () => {};
  const nextStep = (): Promise<Step> =>
    new Promise<Step>((resolve, reject) => {
      resolveStep = resolve;
      rejectStep = reject;
    });

  const callbacks: IAuthenticationCallback = {
    onSuccess: (session: CognitoUserSession) => {
      resolveStep({ kind: 'done', idToken: session.getIdToken().getJwtToken() });
    },

    onFailure: (err: unknown) => {
      rejectStep(toError(err));
    },

    newPasswordRequired: () => {
      resolveStep({
        kind: 'newPasswordRequired',
        complete: (newPassword: string) => {
          const step = nextStep();
          // Empty attributes: the pool provisions users with all required
          // attributes set, and immutable ones must not be re-submitted.
          cognitoUser.completeNewPasswordChallenge(newPassword, {}, callbacks);
          return step;
        },
      });
    },

    mfaSetup: () => {
      cognitoUser.associateSoftwareToken({
        associateSecretCode: (secret: string) => {
          const otpauthUrl =
            `otpauth://totp/Circini:${encodeURIComponent(email)}` +
            `?secret=${secret}&issuer=Circini`;
          resolveStep({
            kind: 'mfaSetup',
            secret,
            otpauthUrl,
            verify: (code: string) => {
              const step = nextStep();
              cognitoUser.verifySoftwareToken(code, 'browser', {
                // Mid-auth, verifySoftwareToken answers the MFA_SETUP
                // challenge itself and hands back the final session (or the
                // error), so route both through the shared callbacks.
                onSuccess: (session: CognitoUserSession) => callbacks.onSuccess(session),
                onFailure: (err: unknown) => callbacks.onFailure(err),
              });
              return step;
            },
          });
        },
        onFailure: (err: unknown) => {
          rejectStep(toError(err));
        },
      });
    },

    totpRequired: () => {
      resolveStep({
        kind: 'totpRequired',
        submit: (code: string) => {
          const step = nextStep();
          cognitoUser.sendMFACode(code, callbacks, 'SOFTWARE_TOKEN_MFA');
          return step;
        },
      });
    },

    selectMFAType: () => {
      // The pool requires TOTP; answer the selection and let the flow
      // continue into totpRequired via the same callbacks.
      cognitoUser.sendMFASelectionAnswer('SOFTWARE_TOKEN_MFA', callbacks);
    },

    // The library invokes these unconditionally for challenge types this app
    // does not support; without handlers it would throw inside its own
    // network callback and leave the pending Step promise hanging forever.
    mfaRequired: () => {
      rejectStep(new Error('SMS sign-in codes are not supported — contact an administrator'));
    },
    customChallenge: () => {
      rejectStep(new Error('Unsupported sign-in challenge — contact an administrator'));
    },
  };

  const step = nextStep();
  cognitoUser.authenticateUser(
    new AuthenticationDetails({ Username: email, Password: password }),
    callbacks
  );
  return step;
}
