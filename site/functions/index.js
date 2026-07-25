/**
 * HTTPS Cloud Function mounting the shared Express beacon API.
 * Env must be set before requiring ./server (store selector reads it at load).
 *
 * Optional: set BEACON_API_KEY on this function (Cloud Console → Variables)
 * to protect register/track/reset/delete. Pixel GIF routes stay public.
 */

const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/https");

process.env.BEACON_STORE = "firestore";
process.env.FIREBASE_PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.FIREBASE_PROJECT_ID ||
  "jobsimp-widget";

setGlobalOptions({maxInstances: 10});

const app = require("./server");

exports.api = onRequest({region: "us-central1"}, app);
