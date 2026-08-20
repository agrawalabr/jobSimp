// Shared email domain: draft helpers, Gmail transport, beacon client, EmailManager.
export * from './draft-email.js';
export * from './gmail.js';
export * from './beacon.js';
export {
  sendTrackedEmail,
  finalizeNativeSend,
  enqueueHardenRegister,
  watchScheduledSend,
  drainEmailTxs,
  installEmailTxAlarms,
  allocBeaconId,
  resolveRegisterMessageId,
} from './manager.js';
