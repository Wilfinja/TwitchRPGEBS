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
const UNITY_INBOUND_URL = process.env.UNITY_INBOUND_URL || "https://desktop-5blpp4r.tail3e1aec.ts.net/";
const PORT              = process.env.PORT              || 3000;

// Can be overridden at runtime by /unity/register-inbound (ngrok URL changes on restart)
let UNITY_INBOUND_URL_OVERRIDE = null;
const getUnityUrl = () => (UNITY_INBOUND_URL_OVERRIDE || UNITY_INBOUND_URL).replace(/\/+$/, "");
 
const PERSIST_DIR  = process.env.PERSIST_PATH || (fs.existsSync("/data") ? "/data" : "/tmp");
const PERSIST_FILE = path.join(PERSIST_DIR, "rpg_viewer_states.json");
 
// How long without a Unity push before we consider the stream offline.
// Set to 60s to survive Unity hitches during expedition wave loading/combat.
const ONLINE_THRESHOLD_MS = 60_000;
 
// ── In-memory state ───────────────────────────────────────────────────────────
 
const viewerStates  = new Map();
let   globalState   = {};
let   lastUnityPingAt = null;
 
// ── Command lockout ───────────────────────────────────────────────────────────
// When a viewer sends equipability / unequipability from the panel, the EBS
// updates its cache optimistically and fires the change to Unity. But Unity's
// batch push timer (every 5s) can fire BEFORE Unity has processed the command,
// sending the OLD loadout back and overwriting the EBS cache — causing the
// panel to revert. We block that viewer's slot in the batch push for 8 seconds,
// which is long enough for the command to reach Unity and for the next batch
// push to carry the correct state.
const commandLockouts = new Map(); // userId → Date.now() when locked
 
function setCommandLockout(userId) {
  commandLockouts.set(userId, Date.now());
}
 
function isLockedOut(userId) {
  const t = commandLockouts.get(userId);
  if (!t) return false;
  if (Date.now() - t >= 8_000) {
    commandLockouts.delete(userId);
    return false;
  }
  return true;
}
 
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
 
// ── Unity → EBS: register current tunnel URL ─────────────────────────────────
// Called by PanelSyncServer on startup with the current ngrok/Funnel URL.
// Updates UNITY_INBOUND_URL in memory so commands reach Unity immediately
// without needing a Railway redeploy.
 
app.post("/unity/register-inbound", requireUnitySecret, (req, res) => {
  const { inboundUrl } = req.body;
  if (!inboundUrl || !inboundUrl.startsWith("http")) {
    return res.status(400).json({ error: "Invalid inboundUrl" });
  }
 
  // Update the in-process variable (persists until next Railway deploy/restart)
  UNITY_INBOUND_URL_OVERRIDE = inboundUrl;
  console.log(`[EBS] Unity inbound URL updated to: ${inboundUrl}`);
  res.json({ ok: true, inboundUrl });
});
 
 
 
// ── Unity → EBS: batch push all viewer states (one request instead of N) ───────
app.post("/unity/push-batch", requireUnitySecret, (req, res) => {
  const { viewers } = req.body;
  if (!Array.isArray(viewers) || viewers.length === 0) {
    return res.status(400).json({ error: "Missing viewers array" });
  }
 
  lastUnityPingAt = Date.now();
  const now = new Date().toISOString();
  let count = 0;
 
  for (const { userId, state } of viewers) {
    if (!userId || !state) continue;
    // If this viewer recently sent an equip/unequip command, the EBS cache
    // already has the correct optimistic state. Skip Unity's push for this
    // viewer until the lockout expires (8s), preventing the rollback.
    if (isLockedOut(userId)) continue;
    const entry = { state, updatedAt: now, lastSeenOnline: now };
    viewerStates.set(userId, entry);
    count++;
 
    // PubSub whisper to each viewer — fire and forget
    broadcastToViewer(userId, { ...state, _online: true, _updatedAt: now })
      .catch(err => console.error(`[PubSub] batch whisper error for ${userId}:`, err.message));
  }
 
  schedulePersist();
  res.json({ ok: true, count });
});
 
app.post("/unity/push", requireUnitySecret, (req, res) => {
  const { userId, state } = req.body;
  if (!userId || !state) return res.status(400).json({ error: "Missing userId or state" });
 
  lastUnityPingAt = Date.now();
 
  // If this viewer recently sent an equip/unequip from the panel, skip the push —
  // the EBS cache already has the correct optimistic state, and Unity hasn't
  // processed the command yet so this push carries stale data.
  if (isLockedOut(userId)) {
    return res.json({ ok: true, skipped: true, reason: "command_lockout" });
  }
 
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
 
// Commands that are flatly rejected when Unity is offline (no point forwarding).
// queue, confirm, equipability, unequipability are NOT listed here — if Unity
// is truly offline the forward will time out with a clear error. Pre-emptive 503s
// cause false rejections during brief push-cycle gaps when Unity IS running.
const REQUIRES_ONLINE = new Set([
  "sell", "buy",
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
 
  // ── All other commands: forward to Unity ───────────────────────────────────
  // equipability and unequipability go through Unity's HandleRPGCommand first
  // (same path as typing in chat). If Tailscale Funnel is down, they fall back
  // to an EBS-side cache update so the panel still reflects the change.
  // All other commands (queue, confirm, etc.) fail hard if Unity is unreachable.
  const isLoadoutCmd = (cmd === "equipability" || cmd === "equipa" ||
                        cmd === "unequipability" || cmd === "unequipa");
 
  if (isLoadoutCmd) setCommandLockout(userId);
 
  let unitySucceeded = false;
  try {
    const unityRes = await fetch(`${getUnityUrl()}/`, {
      method:  "POST",
      headers: {
        "Content-Type":               "application/json",
        "X-EBS-Secret":               EBS_SECRET,
        "ngrok-skip-browser-warning": "1",
      },
      body:    JSON.stringify({ userId, username, command: cmd, args: args || [] }),
      timeout: 10_000,
    });
 
    const data = await unityRes.json();
    if (!unityRes.ok) {
      if (!isLoadoutCmd) return res.status(502).json({ error: "Unity rejected command", detail: data });
      // For loadout commands, a Unity-side rejection (wrong class, already equipped etc.)
      // is a real error — surface it directly.
      return res.json({ success: false, error: data.message || data.error || "Unity rejected command" });
    }
    unitySucceeded = true;
    return res.json(data);
 
  } catch (err) {
    console.error("[Command] Unity forward failed:", err.message);
 
    if (!isLoadoutCmd) {
      // Combat commands need Unity — surface the error clearly.
      return res.status(503).json({
        error:  "Could not reach Unity — is Tailscale Funnel running?",
        hint:   "Run: tailscale funnel --bg 7433",
      });
    }
    // Fall through to EBS-side fallback for loadout commands.
  }
 
  // ── EBS-side fallback for equipability / unequipability ──────────────────
  // Unity was unreachable (Tailscale down). Apply the change to the EBS cache
  // so the panel updates immediately. The change will be lost if Unity never
  // sees it — warn the viewer so they know to re-do it if needed.
  const entry = viewerStates.get(userId);
  if (!entry) {
    return res.status(503).json({ error: "Unity unreachable and no cached state found." });
  }
 
  const abilities = entry.state.abilities || [];
  const available = entry.state.availableAbilities || [];
  const MAX_SLOTS  = entry.state.maxAbilitySlots || 4;
 
  if (cmd === "equipability" || cmd === "equipa") {
    const abilityCmd  = (args && args[0]) ? args[0].toLowerCase() : null;
    if (!abilityCmd) return res.status(400).json({ error: "Missing ability name." });
    if (abilities.length >= MAX_SLOTS)
      return res.json({ success: false, error: `Loadout full (${MAX_SLOTS}/${MAX_SLOTS}).` });
    if (abilities.find(a => a.cmd === abilityCmd))
      return res.json({ success: false, error: `${abilityCmd} is already equipped.` });
    const abilityData = available.find(a => a.cmd === abilityCmd);
    if (!abilityData)
      return res.json({ success: false, error: `Ability '${abilityCmd}' not found or not unlocked.` });
 
    abilities.push(abilityData);
    entry.state.abilities = abilities;
    entry.updatedAt = new Date().toISOString();
    viewerStates.set(userId, entry);
    schedulePersist();
    broadcastToViewer(userId, { ...entry.state, _online: isUnityOnline(), _updatedAt: entry.updatedAt })
      .catch(() => {});
    console.warn(`[Fallback] equipability '${abilityCmd}' applied to EBS cache only for ${userId} — Unity was unreachable`);
    return res.json({ success: true, message: `Equipped ${abilityData.name} (offline — re-equip in chat if it doesn't save).` });
  }
 
  if (cmd === "unequipability" || cmd === "unequipa") {
    const arg = (args && args[0]) ? args[0] : null;
    if (!arg) return res.status(400).json({ error: "Missing slot or ability name." });
    if (abilities.length === 0) return res.json({ success: false, error: "No abilities equipped." });
 
    let removed = null;
    const slotNum = parseInt(arg, 10);
    if (!isNaN(slotNum)) {
      if (slotNum < 1 || slotNum > abilities.length)
        return res.json({ success: false, error: `Invalid slot. You have ${abilities.length} equipped.` });
      removed = abilities.splice(slotNum - 1, 1)[0];
    } else {
      const idx = abilities.findIndex(a => a.cmd === arg.toLowerCase());
      if (idx === -1) return res.json({ success: false, error: `'${arg}' is not in your loadout.` });
      removed = abilities.splice(idx, 1)[0];
    }
 
    entry.state.abilities = abilities;
    entry.updatedAt = new Date().toISOString();
    viewerStates.set(userId, entry);
    schedulePersist();
    broadcastToViewer(userId, { ...entry.state, _online: isUnityOnline(), _updatedAt: entry.updatedAt })
      .catch(() => {});
    console.warn(`[Fallback] unequipability '${removed.cmd}' applied to EBS cache only for ${userId} — Unity was unreachable`);
    return res.json({ success: true, message: `Removed ${removed.name} (offline — re-equip in chat if it doesn't save).` });
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
    unityInboundUrl: getUnityUrl(),
  });
});
 
// ── Debug: detailed status ────────────────────────────────────────────────────
// Hit during a live stream to see exactly what the EBS thinks is happening:
//   https://your-railway-url.up.railway.app/debug/status
app.get("/debug/status", (req, res) => {
  const now     = Date.now();
  const pingAge = lastUnityPingAt ? (now - lastUnityPingAt) : null;
  res.json({
    online:            isUnityOnline(),
    lastUnityPingAt:   lastUnityPingAt ? new Date(lastUnityPingAt).toISOString() : null,
    pingAgeMs:         pingAge,
    pingAgeSeconds:    pingAge ? Math.floor(pingAge / 1000) : null,
    onlineThresholdMs: ONLINE_THRESHOLD_MS,
    viewersCached:     viewerStates.size,
    unityInboundUrl:   getUnityUrl(),
    globalState:       globalState,
  });
});
 
 
// Hit this in your browser to confirm Railway can reach your PC:
//   https://your-railway-url.up.railway.app/debug/ping-unity
// You should see {"reachable":true} if Tailscale + port 7433 are working.
// Remove or protect this endpoint once confirmed working.
// ── Debug: check a specific viewer's cached state ────────────────────────────
// https://your-railway-url.up.railway.app/debug/viewer/TWITCH_USER_ID
app.get("/debug/viewer/:userId", (req, res) => {
  const entry = viewerStates.get(req.params.userId);
  if (!entry) return res.json({ found: false, userId: req.params.userId });
  res.json({
    found:      true,
    userId:     req.params.userId,
    updatedAt:  entry.updatedAt,
    abilities:  entry.state.abilities  || [],
    class:      entry.state.class,
    level:      entry.state.level,
  });
});
 
app.get("/debug/ping-unity", async (req, res) => {
  try {
    const response = await fetch(`${getUnityUrl()}/`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-EBS-Secret": EBS_SECRET,
      },
      body:    JSON.stringify({ userId: "debug", username: "debug", command: "ping", args: [] }),
      timeout: 5_000,
    });
    const text = await response.text();
    res.json({
      reachable:   true,
      status:      response.status,
      body:        text.substring(0, 200),
      unityUrl:    getUnityUrl(),
    });
  } catch (err) {
    res.json({
      reachable:  false,
      error:      err.message,
      unityUrl:   getUnityUrl(),
      hint:       "Check: (1) Tailscale is running, (2) UNITY_INBOUND_URL is your Tailscale IP not localhost, (3) port 7433 is allowed in Windows Firewall",
    });
  }
});
 
// ── Unity → EBS: register current inbound URL ────────────────────────────────
// Called by PanelSyncServer.cs on Start() so Railway always knows the current
// Tailscale Funnel URL without needing to update the env var after every reboot.
// Protected by UNITY_SECRET so only your Unity instance can call it.
app.post("/unity/register-inbound", requireUnitySecret, (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing 'url' field" });
  }
 
  // Basic sanity check — must be https and look like a real URL
  try { new URL(url); } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }
  if (!url.startsWith("https://")) {
    return res.status(400).json({ error: "URL must be https://" });
  }
 
  const previous = UNITY_INBOUND_URL_OVERRIDE || UNITY_INBOUND_URL;
  UNITY_INBOUND_URL_OVERRIDE = url.replace(/\/+$/, ""); // strip trailing slash
  console.log(`[EBS] Unity inbound URL updated: ${previous} → ${UNITY_INBOUND_URL_OVERRIDE}`);
  res.json({ ok: true, unityInboundUrl: UNITY_INBOUND_URL_OVERRIDE });
});
 
 
// Sends a command to Unity's inbound HTTP listener (PanelSyncServer.cs).
// Returns the parsed response body, or throws on network error.
// Callers should .catch() this — it must never block a panel response.
 
async function forwardToUnity(userId, username, command, args) {
  const res = await fetch(`${getUnityUrl()}/`, {
    method:  "POST",
    headers: {
      "Content-Type":              "application/json",
      "X-EBS-Secret":              EBS_SECRET,
      "ngrok-skip-browser-warning": "1",  // needed if using ngrok free tier
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
  console.log(`[EBS] Unity inbound:  ${getUnityUrl()}`);
  console.log(`[EBS] Persist file:   ${PERSIST_FILE}`);
  console.log(`[EBS] PubSub:         ${!!(TWITCH_CLIENT_ID && TWITCH_SECRET)}`);
  console.log(`[EBS] Static files:   ${path.join(__dirname, "public")}`);
});