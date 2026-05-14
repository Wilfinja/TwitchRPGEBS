// ============================================================
//  server.js — RPG Overlay EBS (Extension Backend Service)
//  Deploy to Railway. Set these environment variables:
//
//    UNITY_SECRET       — matches PanelSyncServer.cs sharedSecret
//    EBS_SECRET         — sent back to Unity for inbound commands
//    TWITCH_CLIENT_ID   — your Twitch Extension client ID
//    TWITCH_SECRET      — your Twitch Extension secret (for JWT signing)
//    TWITCH_CHANNEL_ID  — your numeric Twitch channel ID
//    UNITY_INBOUND_URL  — e.g. http://100.x.x.x:7433 (Tailscale/ngrok)
//    PORT               — set automatically by Railway
//    PERSIST_PATH       — optional override for state file directory
//                         (Railway persistent volumes mount at /data)
// ============================================================

const express = require("express");
const cors    = require("cors");
const jwt     = require("jsonwebtoken");
const fetch   = require("node-fetch");
const fs      = require("fs");
const path    = require("path");

const app = express();

// ── Static file serving ───────────────────────────────────────────────────────
// Serves index.html and panel.js from the /public folder.
// These are your Twitch panel extension files.
// Twitch fetches them by their MIME type — Express sets this correctly
// from the file extension (.js → application/javascript, .html → text/html).
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json({ limit: "128kb" }));
app.use(cors());

// ── Config ────────────────────────────────────────────────────────────────────

const UNITY_SECRET      = process.env.UNITY_SECRET      || "fAquxh3jWudjqPtc7DlilLEEA0Wy9zwR";
const EBS_SECRET        = process.env.EBS_SECRET        || "W2rSwaK6hY7a9lMTEgtnlcyNzcKKSoOB";
const TWITCH_CLIENT_ID  = process.env.TWITCH_CLIENT_ID  || "r4vkf1f3llbeprf2psd8dpz1oyiov8";
const TWITCH_SECRET     = process.env.TWITCH_SECRET     || "r9gSD4SBY4p9v1+QTFI6fFqIqsJsiWCxOcwjUkDLfvE=";
const UNITY_INBOUND_URL = process.env.UNITY_INBOUND_URL || "http://localhost:7433";
const PORT              = process.env.PORT              || 3000;

const PERSIST_DIR  = process.env.PERSIST_PATH || (fs.existsSync("/data") ? "/data" : "/tmp");
const PERSIST_FILE = path.join(PERSIST_DIR, "rpg_viewer_states.json");
 
const ONLINE_THRESHOLD_MS = 20_000;
 
// ── In-memory state ───────────────────────────────────────────────────────────
 
const viewerStates  = new Map();
let   globalState   = {};
let   lastUnityPingAt = null;
 
// ── Persistence ───────────────────────────────────────────────────────────────
 
function loadPersistedStates() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) {
      console.log("[Persist] No existing state file found — starting fresh.");
      return;
    }
    const raw  = fs.readFileSync(PERSIST_FILE, "utf8");
    const data = JSON.parse(raw);
 
    if (data.viewers && typeof data.viewers === "object") {
      for (const [userId, entry] of Object.entries(data.viewers)) {
        viewerStates.set(userId, entry);
      }
    }
 
    if (data.globalState) globalState = data.globalState;
 
    console.log(`[Persist] Loaded ${viewerStates.size} viewer(s) from disk (saved ${data.savedAt || "unknown"}).`);
  } catch (err) {
    console.warn("[Persist] Could not load persisted state:", err.message);
  }
}
 
let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistStatesToDisk, 5_000);
}
 
function persistStatesToDisk() {
  try {
    const viewers = {};
    for (const [userId, entry] of viewerStates.entries()) {
      viewers[userId] = entry;
    }
    const data = { viewers, globalState, savedAt: new Date().toISOString() };
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2), "utf8");
    console.log(`[Persist] Saved ${viewerStates.size} viewer(s) to disk.`);
  } catch (err) {
    console.error("[Persist] Write failed:", err.message);
  }
}
 
// ── Online detection ──────────────────────────────────────────────────────────
 
function isUnityOnline() {
  if (!lastUnityPingAt) return false;
  return (Date.now() - lastUnityPingAt) < ONLINE_THRESHOLD_MS;
}
 
function formatLastSeen(isoString) {
  if (!isoString) return null;
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
 
  if (mins  < 2)   return "just now";
  if (mins  < 60)  return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  if (hours < 24)  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (days  === 1) return "yesterday";
  return `${days} days ago`;
}
 
// ── Middleware ────────────────────────────────────────────────────────────────
 
function requireUnitySecret(req, res, next) {
  if (req.headers["x-unity-secret"] !== UNITY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
 
function requireTwitchJwt(req, res, next) {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!token) return res.status(401).json({ error: "Missing JWT" });
 
  try {
    const secret  = Buffer.from(TWITCH_SECRET, "base64");
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
 
  lastUnityPingAt = Date.now();
 
  const now   = new Date().toISOString();
  const entry = {
    state,
    updatedAt:     now,
    lastSeenOnline: now,
  };
 
  viewerStates.set(userId, entry);
  schedulePersist();
 
  broadcastToViewer(userId, { ...state, _online: true, _updatedAt: now })
    .catch(err => console.error("[PubSub] whisper error:", err.message));
 
  res.json({ ok: true });
});
 
// ── Unity → EBS: global state broadcast ──────────────────────────────────────
 
app.post("/unity/broadcast", requireUnitySecret, (req, res) => {
  lastUnityPingAt = Date.now();
  const now = new Date().toISOString();
  globalState = { ...req.body, _online: true, _broadcastAt: now };
 
  schedulePersist();
 
  broadcastGlobal(globalState)
    .catch(err => console.error("[PubSub] broadcast error:", err.message));
 
  res.json({ ok: true });
});
 
// ── Panel → EBS: get state for the authenticated viewer ──────────────────────
 
app.get("/panel/state", requireTwitchJwt, (req, res) => {
  const userId  = req.twitchPayload.user_id;
  const entry   = viewerStates.get(userId) || null;
  const online  = isUnityOnline();
 
  if (!entry) {
    return res.json({
      state:          null,
      globalState:    { ...globalState, _online: online },
      online,
      lastSeenOnline: null,
      lastSeenLabel:  null,
    });
  }
 
  const lastSeenOnline = entry.lastSeenOnline || entry.updatedAt;
  const state = {
    ...entry.state,
    _online:    online,
    _updatedAt: entry.updatedAt,
  };
 
  res.json({
    state,
    globalState:    { ...globalState, _online: online },
    online,
    lastSeenOnline,
    lastSeenLabel: online ? null : formatLastSeen(lastSeenOnline),
  });
});
 
// ── Panel → EBS: send a command ───────────────────────────────────────────────
 
const ALLOWED_PANEL_COMMANDS = new Set([
  "queue", "q", "confirm", "stats", "inventory", "inv",
  "abilities", "loadout", "equip", "unequip",
  "equipability", "unequipability", "levelup",
  "sell", "buy", "shop", "coins", "balance",
  "stance", "stances", "pvpstats",
]);
 
const REQUIRES_ONLINE = new Set([
  "queue", "q", "confirm",
  "sell", "buy", "levelup",
]);
 
app.post("/panel/command", requireTwitchJwt, async (req, res) => {
  const { command, args } = req.body;
  const userId   = req.twitchPayload.user_id;
  const username = req.twitchPayload.login || "unknown";
 
  if (!command) return res.status(400).json({ error: "Missing command" });
 
  const cmd = command.toLowerCase();
  if (!ALLOWED_PANEL_COMMANDS.has(cmd)) {
    return res.status(400).json({ error: `Command '${command}' not available via panel` });
  }
 
  if (REQUIRES_ONLINE.has(cmd) && !isUnityOnline()) {
    return res.status(503).json({
      error:   "Stream is offline",
      offline: true,
      hint:    "This action requires the stream to be live.",
    });
  }
 
  // ── EBS-side loadout commands ───────────────────────────────────────────────
  // equipability and unequipability only touch viewer.equippedAbilities in the
  // cached state. We handle them here so they work even if the Tailscale tunnel
  // is down, then push the updated state so the panel refreshes immediately.
 
  if (cmd === "equipability" || cmd === "equipa") {
    const entry = viewerStates.get(userId);
    if (!entry) return res.status(404).json({ error: "Viewer not found. Join the game first." });
 
    const abilityCmd = (args && args[0]) ? args[0].toLowerCase() : null;
    if (!abilityCmd) return res.status(400).json({ error: "Missing ability name." });
 
    const abilities = entry.state.abilities || [];
    const MAX_SLOTS = entry.state.maxAbilitySlots || 4;
 
    if (abilities.length >= MAX_SLOTS) {
      return res.json({ success: false, error: `Loadout full (${MAX_SLOTS}/${MAX_SLOTS}). Unequip one first.` });
    }
    if (abilities.find(a => a.cmd === abilityCmd)) {
      return res.json({ success: false, error: `${abilityCmd} is already in your loadout.` });
    }
 
    const available = entry.state.availableAbilities || [];
    const abilityData = available.find(a => a.cmd === abilityCmd);
    if (!abilityData) {
      return res.json({ success: false, error: `Ability '${abilityCmd}' not found or not yet unlocked.` });
    }
 
    // Update EBS cache first
    abilities.push(abilityData);
    entry.state.abilities = abilities;
    entry.updatedAt = new Date().toISOString();
    viewerStates.set(userId, entry);
    schedulePersist();
 
    // Forward to Unity so RPGManager saves the change — fire and forget
    forwardToUnity(userId, username, "equipability", [abilityCmd])
      .catch(err => console.warn("[Command] Unity equipability forward failed:", err.message));
 
    // Push updated state to panel via PubSub
    broadcastToViewer(userId, { ...entry.state, _online: isUnityOnline(), _updatedAt: entry.updatedAt })
      .catch(err => console.error("[PubSub] equipability push error:", err.message));
 
    return res.json({ success: true, message: `Equipped ${abilityData.name}! Slots: ${abilities.length}/${MAX_SLOTS}` });
  }
 
  if (cmd === "unequipability" || cmd === "unequipa") {
    const entry = viewerStates.get(userId);
    if (!entry) return res.status(404).json({ error: "Viewer not found. Join the game first." });
 
    const abilities = entry.state.abilities || [];
    if (abilities.length === 0) {
      return res.json({ success: false, error: "No abilities equipped." });
    }
 
    const arg = (args && args[0]) ? args[0] : null;
    if (!arg) return res.status(400).json({ error: "Provide a slot number or ability name." });
 
    let removed = null;
    const slotNum = parseInt(arg, 10);
 
    if (!isNaN(slotNum)) {
      if (slotNum < 1 || slotNum > abilities.length) {
        return res.json({ success: false, error: `Invalid slot. You have ${abilities.length} abilities equipped.` });
      }
      removed = abilities.splice(slotNum - 1, 1)[0];
    } else {
      const idx = abilities.findIndex(a => a.cmd === arg.toLowerCase());
      if (idx === -1) {
        return res.json({ success: false, error: `'${arg}' is not in your loadout.` });
      }
      removed = abilities.splice(idx, 1)[0];
    }
 
    // Update EBS cache
    entry.state.abilities = abilities;
    entry.updatedAt = new Date().toISOString();
    viewerStates.set(userId, entry);
    schedulePersist();
 
    // Forward to Unity by cmd name — Unity will find the slot itself
    forwardToUnity(userId, username, "unequipability", [removed.cmd])
      .catch(err => console.warn("[Command] Unity unequipability forward failed:", err.message));
 
    // Push updated state to panel
    broadcastToViewer(userId, { ...entry.state, _online: isUnityOnline(), _updatedAt: entry.updatedAt })
      .catch(err => console.error("[PubSub] unequipability push error:", err.message));
 
    const MAX_SLOTS = entry.state.maxAbilitySlots || 4;
    return res.json({ success: true, message: `Removed ${removed.name} from loadout. Slots: ${abilities.length}/${MAX_SLOTS}` });
  }
 
  // ── All other commands: forward to Unity ───────────────────────────────────
  try {
    const unityRes = await fetch(`${UNITY_INBOUND_URL}/`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-EBS-Secret": EBS_SECRET,
      },
      body:    JSON.stringify({ userId, username, command: cmd, args: args || [] }),
      timeout: 10_000,
    });
 
    const data = await unityRes.json();
    if (!unityRes.ok) {
      return res.status(502).json({ error: "Unity rejected command", detail: data });
    }
    res.json(data);
  } catch (err) {
    console.error("[Command] Unity unreachable:", err.message);
    lastUnityPingAt = null;
    res.status(503).json({
      error:   "Stream is offline",
      offline: true,
      hint:    "Make sure the stream is live and PanelSyncServer is running.",
    });
  }
});
 
// ── Panel → EBS: poll global state ───────────────────────────────────────────
 
app.get("/panel/global", requireTwitchJwt, (req, res) => {
  const online = isUnityOnline();
  res.json({ ...globalState, _online: online });
});
 
// ── Health check ──────────────────────────────────────────────────────────────
 
app.get("/health", (req, res) => {
  const online = isUnityOnline();
  res.json({
    ok:              true,
    online,
    viewersCached:   viewerStates.size,
    lastUnityPingAt: lastUnityPingAt ? new Date(lastUnityPingAt).toISOString() : null,
    persistFile:     PERSIST_FILE,
  });
});
 
// ── Unity forward helper ──────────────────────────────────────────────────────
// Sends a command to Unity's inbound HTTP listener (PanelSyncServer.cs).
// Returns the parsed response body, or throws on network error.
// Callers should .catch() this — it must never block a panel response.
 
async function forwardToUnity(userId, username, command, args) {
  const res = await fetch(`${UNITY_INBOUND_URL}/`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-EBS-Secret": EBS_SECRET,
    },
    body:    JSON.stringify({ userId, username, command, args: args || [] }),
    timeout: 8_000,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Unity returned ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}
 
// ── Twitch PubSub ─────────────────────────────────────────────────────────────
 
function makePubSubJwt(channelId, targetType, targets) {
  const secret = Buffer.from(TWITCH_SECRET, "base64");
  return jwt.sign(
    {
      exp:        Math.floor(Date.now() / 1000) + 30,
      user_id:    channelId,
      role:       "external",
      channel_id: channelId,
      pubsub_perms: {
        send: [targetType === "broadcast" ? "broadcast" : `whisper-${targets[0]}`],
      },
    },
    secret
  );
}
 
async function broadcastToViewer(userId, state) {
  if (!TWITCH_CLIENT_ID || !TWITCH_SECRET) return;
  const channelId = process.env.TWITCH_CHANNEL_ID || "";
  if (!channelId) return;
 
  const token   = makePubSubJwt(channelId, "whisper", [userId]);
  const message = JSON.stringify({ type: "viewer_state", data: state });
 
  await fetch("https://api.twitch.tv/helix/extensions/pubsub", {
    method:  "POST",
    headers: {
      "Client-Id":    TWITCH_CLIENT_ID,
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      target:              ["whisper-" + userId],
      broadcaster_id:      channelId,
      is_global_broadcast: false,
      message,
    }),
  });
}
 
async function broadcastGlobal(state) {
  if (!TWITCH_CLIENT_ID || !TWITCH_SECRET) return;
  const channelId = process.env.TWITCH_CHANNEL_ID || "";
  if (!channelId) return;
 
  const token   = makePubSubJwt(channelId, "broadcast", []);
  const message = JSON.stringify({ type: "global_state", data: state });
 
  await fetch("https://api.twitch.tv/helix/extensions/pubsub", {
    method:  "POST",
    headers: {
      "Client-Id":    TWITCH_CLIENT_ID,
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      target:              ["broadcast"],
      broadcaster_id:      channelId,
      is_global_broadcast: false,
      message,
    }),
  });
}
 
// ── Boot ──────────────────────────────────────────────────────────────────────
 
loadPersistedStates();
 
app.listen(PORT, () => {
  console.log(`[EBS] Running on port ${PORT}`);
  console.log(`[EBS] Unity inbound:  ${UNITY_INBOUND_URL}`);
  console.log(`[EBS] Persist file:   ${PERSIST_FILE}`);
  console.log(`[EBS] PubSub:         ${!!(TWITCH_CLIENT_ID && TWITCH_SECRET)}`);
  console.log(`[EBS] Static files:   ${path.join(__dirname, "public")}`);
});