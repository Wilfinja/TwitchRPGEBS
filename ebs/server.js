// ============================================================
//  server.js — RPG Overlay EBS (Extension Backend Service)
//  Deploy to Railway. Set these environment variables:
//
//    UNITY_SECRET      — matches PanelSyncServer.cs sharedSecret
//    EBS_SECRET        — sent back to Unity for inbound commands
//    TWITCH_CLIENT_ID  — your Twitch Extension client ID
//    TWITCH_SECRET     — your Twitch Extension secret (for JWT signing)
//    UNITY_INBOUND_URL — e.g. http://YOUR_PC_IP:7433  (ngrok or Tailscale)
//    PORT              — set automatically by Railway
// ============================================================

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(cors());

// ── Config ────────────────────────────────────────────────────────────────────

const UNITY_SECRET = process.env.UNITY_SECRET || "CHANGE_ME";
const EBS_SECRET = process.env.EBS_SECRET || "CHANGE_ME_EBS";
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_SECRET = process.env.TWITCH_SECRET || ""; // base64 Extension secret
const UNITY_INBOUND_URL = process.env.UNITY_INBOUND_URL || "http://localhost:7433";
const PORT = process.env.PORT || 3000;

// In-memory state store: userId → latest viewer state JSON
// Also holds the single "global" state broadcast
const viewerStates = new Map();
let globalState = {};

// ── Middleware: verify Unity → EBS calls ─────────────────────────────────────

function requireUnitySecret(req, res, next) {
  if (req.headers["x-unity-secret"] !== UNITY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Middleware: verify Twitch panel JWT ───────────────────────────────────────

function requireTwitchJwt(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;

  if (!token) return res.status(401).json({ error: "Missing JWT" });

  try {
    const secret = Buffer.from(TWITCH_SECRET, "base64");
    const decoded = jwt.verify(token, secret);
    req.twitchPayload = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid JWT", detail: err.message });
  }
}

// ── Unity → EBS: push a single viewer's state ────────────────────────────────

app.post("/unity/push", requireUnitySecret, (req, res) => {
  const { userId, state } = req.body;
  if (!userId || !state) return res.status(400).json({ error: "Missing userId or state" });

  viewerStates.set(userId, state);

  // Broadcast to that viewer's panel via Twitch PubSub (whisper = viewer-specific)
  broadcastToViewer(userId, state).catch((err) =>
    console.error("[PubSub] whisper error:", err.message)
  );

  res.json({ ok: true });
});

// ── Unity → EBS: global state broadcast (expedition, PvP, shop timer) ────────

app.post("/unity/broadcast", requireUnitySecret, (req, res) => {
  globalState = req.body;

  // Broadcast to ALL viewers watching the channel
  broadcastGlobal(globalState).catch((err) =>
    console.error("[PubSub] broadcast error:", err.message)
  );

  res.json({ ok: true });
});

// ── Panel → EBS: get cached state for the authenticated viewer ────────────────

app.get("/panel/state", requireTwitchJwt, (req, res) => {
  const userId = req.twitchPayload.user_id;
  const state = viewerStates.get(userId) || null;
  res.json({ state, globalState });
});

// ── Panel → EBS: send a command (queue ability, equip, etc.) ─────────────────

const ALLOWED_PANEL_COMMANDS = new Set([
  "queue", "q", "confirm", "stats", "inventory", "inv",
  "abilities", "loadout", "equip", "unequip",
  "equipability", "unequipability", "levelup",
  "sell", "buy", "shop", "coins", "balance",
  "stance", "stances", "pvpstats",
]);

app.post("/panel/command", requireTwitchJwt, async (req, res) => {
  const { command, args } = req.body;
  const userId = req.twitchPayload.user_id;
  const username = req.twitchPayload.login || "unknown";

  if (!command) return res.status(400).json({ error: "Missing command" });
  if (!ALLOWED_PANEL_COMMANDS.has(command.toLowerCase())) {
    return res.status(400).json({ error: `Command '${command}' not available via panel` });
  }

  // Forward to Unity's inbound HTTP server
  try {
    const unityRes = await fetch(`${UNITY_INBOUND_URL}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-EBS-Secret": EBS_SECRET,
      },
      body: JSON.stringify({ userId, username, command, args: args || [] }),
      timeout: 10000,
    });

    const data = await unityRes.json();

    if (!unityRes.ok) {
      return res.status(502).json({ error: "Unity rejected command", detail: data });
    }

    res.json(data);
  } catch (err) {
    console.error("[Command] Unity unreachable:", err.message);
    res.status(503).json({
      error: "Unity is offline or unreachable",
      hint: "Make sure the stream is live and PanelSyncServer is running",
    });
  }
});

// ── Panel → EBS: poll global state (fallback for PubSub failures) ────────────

app.get("/panel/global", requireTwitchJwt, (req, res) => {
  res.json(globalState);
});

// ── Health check (Railway uses this to confirm the app is up) ────────────────

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    viewersCached: viewerStates.size,
    hasGlobalState: Object.keys(globalState).length > 0,
  });
});

// ── Twitch PubSub helpers ─────────────────────────────────────────────────────

function makePubSubJwt(channelId, targetType, targets) {
  const secret = Buffer.from(TWITCH_SECRET, "base64");
  return jwt.sign(
    {
      exp: Math.floor(Date.now() / 1000) + 30,
      user_id: channelId,
      role: "external",
      channel_id: channelId,
      pubsub_perms: {
        send: [targetType === "broadcast" ? "broadcast" : `whisper-${targets[0]}`],
      },
    },
    secret
  );
}

async function broadcastToViewer(userId, state) {
  if (!TWITCH_CLIENT_ID || !TWITCH_SECRET) return; // Not configured in dev

  // We need the channel_id — in a real deploy you'd look this up via Helix
  // For now, store it on first push if Unity sends it, or use a config var
  const channelId = process.env.TWITCH_CHANNEL_ID || "";
  if (!channelId) return;

  const token = makePubSubJwt(channelId, "whisper", [userId]);
  const message = JSON.stringify({ type: "viewer_state", data: state });

  await fetch("https://api.twitch.tv/helix/extensions/pubsub", {
    method: "POST",
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      target: ["whisper-" + userId],
      broadcaster_id: channelId,
      is_global_broadcast: false,
      message,
    }),
  });
}

async function broadcastGlobal(state) {
  if (!TWITCH_CLIENT_ID || !TWITCH_SECRET) return;

  const channelId = process.env.TWITCH_CHANNEL_ID || "";
  if (!channelId) return;

  const token = makePubSubJwt(channelId, "broadcast", []);
  const message = JSON.stringify({ type: "global_state", data: state });

  await fetch("https://api.twitch.tv/helix/extensions/pubsub", {
    method: "POST",
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      target: ["broadcast"],
      broadcaster_id: channelId,
      is_global_broadcast: false,
      message,
    }),
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[EBS] Running on port ${PORT}`);
  console.log(`[EBS] Unity inbound URL: ${UNITY_INBOUND_URL}`);
  console.log(`[EBS] PubSub configured: ${!!(TWITCH_CLIENT_ID && TWITCH_SECRET)}`);
});
