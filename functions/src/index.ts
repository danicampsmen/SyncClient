import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId : "syncclient-ac0a8";
admin.initializeApp({
  databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`
});

export const driveWebhook = functions.https.onRequest(async (request, response) => {
  const channelId = request.headers["x-goog-channel-id"];
  const resourceState = request.headers["x-goog-resource-state"];

  if (!channelId) {
    // If there's no channel ID, it's not a valid Drive Webhook request
    response.status(400).send("Missing channel ID");
    return;
  }

  // Google sends a 'sync' event when the channel is successfully created
  // We can ignore it or just record it
  if (resourceState === "sync") {
    functions.logger.info(`Channel ${channelId} synced/created`);
    response.status(200).send("OK");
    return;
  }

  try {
    const channelIdStr = Array.isArray(channelId) ? channelId[0] : channelId;
    
    // Update Realtime Database to notify the desktop client
    const dbRef = admin.database().ref(`drive_events/${channelIdStr}`);
    await dbRef.set({
      timestamp: admin.database.ServerValue.TIMESTAMP,
      state: resourceState || "update"
    });

    functions.logger.info(`Notified RTDB for channel ${channelIdStr}`);
    response.status(200).send("OK");
  } catch (error) {
    functions.logger.error("Error writing to RTDB:", error);
    response.status(500).send("Internal Error");
  }
});
