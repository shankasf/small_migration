/** Accountable owner's policy: retain all durable application records indefinitely. */
export const retentionPolicy = Object.freeze({
  chats: 'indefinite', uploads: 'indefinite', outputs: 'indefinite',
  aiActivity: 'indefinite', usage: 'indefinite', audit: 'indefinite',
  automaticDeletion: false,
});
