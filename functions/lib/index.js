"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.driveWebhook = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId : "syncclient-ac0a8";
admin.initializeApp({
    databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`
});
exports.driveWebhook = functions.https.onRequest(async (request, response) => {
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
    }
    catch (error) {
        functions.logger.error("Error writing to RTDB:", error);
        response.status(500).send("Internal Error");
    }
});
//# sourceMappingURL=index.js.map