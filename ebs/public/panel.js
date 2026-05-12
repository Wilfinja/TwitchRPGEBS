// ── Config ────────────────────────────────────────────────────────────────────
const EBS_URL = "https://twitchrpgebs-production-e7e6.up.railway.app"; // REPLACE WITH YOUR RAILWAY URL

// ── Twitch helper ─────────────────────────────────────────────────────────────
let twitchJwt = null;
let twitchUserId = null;
let currentState = null;
let currentGlobal = {};
let queuedAbility = null;
let maxTurnTime = 45;

// ── Init ──────────────────────────────────────────────────────────────────────
// Twitch.ext is injected by the host page. We must wait until it's available
// before calling onAuthorized. If it never appears (local dev), fall back to
// mock data after a short timeout.

function initTwitch() {
  const Twitch = window.Twitch?.ext;

  if (!Twitch) {
    // Running outside the Twitch extension iframe — show mock data for dev
    console.warn("[Panel] window.Twitch.ext not found — loading mock data");
    setTimeout(() => loadMockData(), 300);
    return;
  }

  // onAuthorized fires when Twitch has a valid token for this viewer.
  // It also re-fires when the token is refreshed (~1hr), so fetchState()
  // will run again automatically on long sessions.
  Twitch.onAuthorized(auth => {
    twitchJwt    = auth.token;
    twitchUserId = auth.userId;
    console.log("[Panel] Authorized. userId:", twitchUserId);
    fetchState();

    // PubSub: global broadcast (all viewers)
    Twitch.listen("broadcast", (_, __, msg) => {
      const parsed = safeParseJson(msg);
      if (!parsed) return;
      if (parsed.type === "global_state") handleGlobalState(parsed.data || parsed);
      if (parsed.type === "viewer_state") handleViewerState(parsed.data || parsed);
    });

    // PubSub: whisper for this specific viewer
    Twitch.listen("whisper-" + twitchUserId, (_, __, msg) => {
      const parsed = safeParseJson(msg);
      if (!parsed) return;
      if (parsed.type === "viewer_state") handleViewerState(parsed.data || parsed);
    });
  });

  // Safety net: if onAuthorized hasn't fired after 8s the JWT is taking too
  // long or the extension context isn't set up correctly. Show a hint.
  setTimeout(() => {
    if (!twitchJwt) {
      console.warn("[Panel] onAuthorized hasn't fired after 8s — check extension config");
      document.querySelector(".loading-text").textContent = "WAITING FOR TWITCH AUTH...";
    }
  }, 8000);
}

// Run after DOM is ready (inline scripts run before </body>, but being explicit
// ensures Twitch.ext — loaded in <head> — has had time to register itself).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTwitch);
} else {
  initTwitch();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("pane-" + tab.dataset.tab).classList.add("active");
  });
});

// ── Fetch state (initial load / poll fallback) ────────────────────────────────
async function fetchState() {
  // Don't attempt fetch without a JWT — would always 401
  if (!twitchJwt) {
    console.warn("[Panel] fetchState skipped — no JWT yet");
    return;
  }

  try {
    const res = await fetch(EBS_URL + "/panel/state", {
      headers: { Authorization: "Bearer " + twitchJwt }
    });

    // Surface HTTP errors visibly instead of silently failing
    if (!res.ok) {
      const text = await res.text();
      console.error(`[Panel] /panel/state returned ${res.status}:`, text);
      document.querySelector(".loading-text").textContent = `EBS ERROR ${res.status}`;
      return;
    }

    const data = await res.json();

    // Debug: log exactly what the EBS returned
    console.log("[Panel] /panel/state response:", JSON.stringify(data).substring(0, 300));

    if (data.state) {
      console.log("[Panel] Got state for userId:", data.state.userId, "class:", data.state.class);
      handleViewerState(data.state);
    } else {
      // EBS has no data for this viewer yet — show a helpful message
      console.warn("[Panel] EBS returned null state. Your userId may not be in the viewer database yet.");
      console.warn("[Panel] Twitch userId:", twitchUserId, "— make sure this matches what Unity is pushing.");
      document.querySelector(".loading-text").textContent = "NOT IN REALM YET — TYPE !join IN CHAT";
    }

    if (data.globalState) handleGlobalState(data.globalState);

  } catch(e) {
    console.error("[Panel] fetchState failed:", e.message);
    document.querySelector(".loading-text").textContent = "CONNECTION ERROR — CHECK CONSOLE";
  }
}

// Poll every 8s as fallback if PubSub misses — only runs when JWT is present
setInterval(() => { if (twitchJwt) fetchState(); }, 8000);

// ── Handle state updates ──────────────────────────────────────────────────────
function handleViewerState(state) {
  if (!state) return;
  currentState = state;

  // Hide loading
  document.getElementById("loading-screen").classList.add("hidden");

  // No class yet
  if (state.class === "None" || !state.class) {
    document.getElementById("no-class-screen").classList.add("show");
    return;
  }
  document.getElementById("no-class-screen").classList.remove("show");

  updateHeader(state);
  updateStats(state);
  updateAbilities(state);
  updateInventory(state);
}

function handleGlobalState(g) {
  if (!g) return;
  currentGlobal = g;
  updateGlobalStatus(g);
  updateCombatUI(g);
}

// ── Header ────────────────────────────────────────────────────────────────────
function updateHeader(s) {
  document.getElementById("char-name").textContent = s.username || "Adventurer";
  document.getElementById("char-level").textContent = "Lv. " + (s.level || 1);

  const badge = document.getElementById("char-class-badge");
  badge.textContent = (s.class || "").toUpperCase();
  badge.style.display = s.class && s.class !== "None" ? "block" : "none";
  badge.style.background = classColor(s.class);

  // XP
  const xpProgress = Math.min(1, s.xpProgress || 0);
  document.getElementById("xp-bar-fill").style.width = (xpProgress * 100).toFixed(1) + "%";
  document.getElementById("xp-val").textContent = (s.xp || 0) + " / " + (s.xpNeeded || 150);

  // HP
  const hpPercent = s.maxHp > 0 ? Math.min(1, s.hp / s.maxHp) : 1;
  document.getElementById("hp-bar-fill").style.width = (hpPercent * 100).toFixed(1) + "%";
  document.getElementById("hp-val").textContent = (s.hp || 0) + " / " + (s.maxHp || 100);
  document.getElementById("hp-bar-fill").style.background =
    hpPercent > 0.6 ? "linear-gradient(90deg,#6b1212,#c0392b)" :
    hpPercent > 0.3 ? "linear-gradient(90deg,#7a4b12,#e67e22)" :
                      "linear-gradient(90deg,#7a1212,#e74c3c)";

  document.getElementById("coins-amount").textContent = (s.coins || 0).toLocaleString();
}

function classColor(cls) {
  const map = {
    Rogue:   "#5c1a7c",
    Fighter: "#8b1a1a",
    Mage:    "#1a3d7c",
    Cleric:  "#1a6b3c",
    Ranger:  "#3d5c1a",
  };
  return map[cls] || "#7a6030";
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(s) {
  const total = s.stats || {};
  const base  = s.baseStats || {};

  const statKeys = [
    ["str", "stat-str", "stat-str-bonus"],
    ["con", "stat-con", "stat-con-bonus"],
    ["dex", "stat-dex", "stat-dex-bonus"],
    ["wil", "stat-wil", "stat-wil-bonus"],
    ["cha", "stat-cha", "stat-cha-bonus"],
    ["int", "stat-int", "stat-int-bonus"],
  ];

  statKeys.forEach(([key, valId, bonusId]) => {
    const t = total[key] || 0;
    const b = base[key]  || 0;
    const diff = t - b;
    document.getElementById(valId).textContent = t;
    const bonusEl = document.getElementById(bonusId);
    if (diff > 0) {
      bonusEl.textContent = "+" + diff + " from gear";
      bonusEl.className = "stat-box-bonus";
    } else if (diff < 0) {
      bonusEl.textContent = diff + " from gear";
      bonusEl.className = "stat-box-bonus negative";
    } else {
      bonusEl.textContent = "";
    }
  });

  document.getElementById("cs-damage").textContent  = "+" + (s.damageBonus  || 0);
  document.getElementById("cs-defense").textContent = "+" + (s.defenseBonus || 0);

  const wins   = s.pvpWins   || 0;
  const losses = s.pvpLosses || 0;
  const total2 = wins + losses;
  document.getElementById("pvp-wins").textContent   = wins;
  document.getElementById("pvp-losses").textContent = losses;
  document.getElementById("pvp-rate").textContent   = total2 > 0 ? Math.round(wins/total2*100) + "%" : "—";

  const points = s.unallocatedPoints || 0;
  const banner = document.getElementById("unallocated-banner");
  if (points > 0) {
    banner.classList.add("show");
    document.getElementById("unallocated-text").textContent = "★ " + points + " stat point" + (points > 1 ? "s" : "") + " to allocate!";
  } else {
    banner.classList.remove("show");
  }
}

// ── Combat UI ─────────────────────────────────────────────────────────────────
function updateGlobalStatus(g) {
  const el = document.getElementById("global-status");
  el.className = "";
  if (g.pvpActive) { el.textContent = "⚔ PvP Match"; el.classList.add("pvp"); }
  else if (g.expeditionActive && g.combatActive)  { el.textContent = `⚔ Wave ${g.wave}/${g.totalWaves}`; el.classList.add("expedition"); }
  else if (g.expeditionActive)  { el.textContent = "🗡 Expedition"; el.classList.add("expedition"); }
  else { el.textContent = "Idle · Shop " + (g.shopRefresh || ""); }
}

function updateCombatUI(g) {
  const isPlayerTurn = g.isPlayerTurn && g.combatActive;
  const turnStatus = document.getElementById("turn-status");
  const timerBar = document.getElementById("turn-timer-bar");
  const timerFill = document.getElementById("turn-timer-fill");
  const confirmBtn = document.getElementById("confirm-btn");

  if (g.combatActive) {
    turnStatus.classList.add("show");
    timerBar.classList.add("show");
    if (isPlayerTurn) {
      turnStatus.textContent = "⚔ PLAYER TURN";
      turnStatus.className = "show player-turn";
      confirmBtn.classList.add("show");
      const pct = g.turnTimer > 0 ? Math.min(100, (g.turnTimer / maxTurnTime) * 100) : 0;
      timerFill.style.width = pct + "%";
      timerFill.style.background = pct > 50 ? "linear-gradient(90deg,#27ae60,#2ecc71)"
        : pct > 25 ? "linear-gradient(90deg,#f39c12,#f1c40f)"
        : "linear-gradient(90deg,#c0392b,#e74c3c)";
    } else {
      turnStatus.textContent = "⏳ ENEMY TURN";
      turnStatus.className = "show enemy-turn";
      confirmBtn.classList.remove("show");
      timerFill.style.width = "0%";
    }
  } else {
    turnStatus.classList.remove("show");
    timerBar.classList.remove("show");
    confirmBtn.classList.remove("show");
    queuedAbility = null;
  }

  // Update queued button states
  document.querySelectorAll(".ability-queue-btn").forEach(btn => {
    const cmd = btn.dataset.cmd;
    if (!g.combatActive || !isPlayerTurn) {
      btn.classList.add("disabled");
      btn.classList.remove("queued");
      btn.textContent = g.combatActive ? "WAIT" : "OUT OF COMBAT";
    } else {
      btn.classList.remove("disabled");
      if (currentState && currentState.queuedAction === cmd) {
        btn.classList.add("queued");
        btn.textContent = "✓ QUEUED";
      } else {
        btn.classList.remove("queued");
        btn.textContent = "QUEUE";
      }
    }
  });
}

// ── Abilities ─────────────────────────────────────────────────────────────────
const ABILITY_ICONS = {
  Damage: "⚔", Heal: "💚", Buff: "✨", Debuff: "💀"
};

const CLASS_ABILITY_ICONS = {
  Rogue: "🗡", Fighter: "🛡", Mage: "🔮", Cleric: "✝", Ranger: "🏹"
};

function updateAbilities(s) {
  const list = document.getElementById("abilities-list");
  const abilities = s.abilities || [];

  if (abilities.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:11px;text-align:center;padding:12px 0;">No abilities equipped.<br><small style="font-size:10px">Type !equipability &lt;name&gt; in chat.</small></div>';
    return;
  }

  const isPlayerTurn = currentGlobal.isPlayerTurn && currentGlobal.combatActive;

  list.innerHTML = abilities.map(ab => {
    const icon = CLASS_ABILITY_ICONS[s.class] || "⚔";
    const isQueued = s.queuedAction === ab.cmd;
    const disabled = !currentGlobal.combatActive || !isPlayerTurn;
    const btnClass = isQueued ? "ability-queue-btn queued" : (disabled ? "ability-queue-btn disabled" : "ability-queue-btn");
    const btnText  = isQueued ? "✓ QUEUED" : (disabled ? (currentGlobal.combatActive ? "WAIT" : "OUT OF COMBAT") : "QUEUE");

    return `
      <div class="ability-card">
        <div class="ability-card-top">
          <div class="ability-icon">${icon}</div>
          <div style="flex:1">
            <div class="ability-name">${escHtml(ab.name)}</div>
            <div class="ability-cmd">!queue ${escHtml(ab.cmd)}</div>
          </div>
          <button class="ability-queue-btn ${disabled ? 'disabled' : ''} ${isQueued ? 'queued' : ''}"
            data-cmd="${escAttr(ab.cmd)}"
            onclick="queueAbility('${escAttr(ab.cmd)}')">${btnText}</button>
        </div>
      </div>`;
  }).join("");
}

async function queueAbility(cmd) {
  if (!currentGlobal.combatActive || !currentGlobal.isPlayerTurn) {
    showToast("It's not the player turn!", "error");
    return;
  }

  showToast("Queueing " + cmd + "…");
  const result = await sendCommand("queue", [cmd]);
  if (result && result.success) {
    queuedAbility = cmd;
    if (currentState) currentState.queuedAction = cmd;
    updateAbilities(currentState);
    updateCombatUI(currentGlobal);
    showToast(result.message || "Queued!", "success");
  }
}

// ── Inventory ─────────────────────────────────────────────────────────────────
function updateInventory(s) {
  const eq = s.equipped || {};

  const setSlot = (id, val) => {
    const el = document.getElementById(id);
    if (val) { el.textContent = val; el.className = "equip-slot-name"; }
    else      { el.textContent = "—"; el.className = "equip-slot-name empty"; }
  };

  setSlot("eq-head",  eq.head);
  setSlot("eq-chest", eq.chest);
  setSlot("eq-main",  eq.mainHand);
  setSlot("eq-off",   eq.offHand);
  setSlot("eq-arms",  eq.arms);
  setSlot("eq-legs",  eq.legs);

  const total = s.inventoryCount || 0;
  document.getElementById("inv-count-label").textContent = total + " / 50";

  const grid = document.getElementById("inventory-grid");
  const items = s.inventory || [];

  if (items.length === 0) {
    grid.innerHTML = '<div style="color:var(--text-dim);font-size:11px;grid-column:1/-1;text-align:center;padding:12px 0;">Inventory is empty.</div>';
    return;
  }

  grid.innerHTML = items.map((item, i) => {
    const rarityClass = "rarity-" + (item.rarity || "Common").toLowerCase();
    return `
      <div class="inv-item" title="${escAttr(item.name)} (${item.rarity}) — ${item.price}c">
        <div class="inv-item-name">${escHtml(item.name || "?")}</div>
        <div class="inv-item-rarity ${rarityClass}">${(item.rarity||"").toUpperCase().slice(0,3)}</div>
      </div>`;
  }).join("");

  if (total > items.length) {
    grid.innerHTML += `<div style="color:var(--text-dim);font-size:10px;grid-column:1/-1;text-align:center;padding:6px 0;">+${total - items.length} more items</div>`;
  }
}

// ── Command sender ────────────────────────────────────────────────────────────
async function sendCommand(command, args) {
  if (!twitchJwt) {
    showToast("Not authenticated with Twitch", "error");
    return null;
  }

  try {
    const res = await fetch(EBS_URL + "/panel/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + twitchJwt,
      },
      body: JSON.stringify({ command, args }),
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || "Command failed", "error");
      return null;
    }

    return data;
  } catch(e) {
    showToast("Connection error — is the stream live?", "error");
    return null;
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;

function showToast(msg, type) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show" + (type ? " " + type : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = "", 3000);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function escAttr(s) { return escHtml(s).replace(/'/g,"&#39;"); }

// ── Dev mock data ─────────────────────────────────────────────────────────────
function loadMockData() {
  handleViewerState({
    userId: "mock123", username: "DragonSlayer99",
    class: "Rogue", level: 12, coins: 4250,
    xp: 87, xpNeeded: 150, xpProgress: 0.58,
    hp: 142, maxHp: 185,
    unallocatedPoints: 2,
    stats: { str:8, con:10, dex:22, wil:5, cha:6, int:4 },
    baseStats: { str:6, con:8, dex:18, wil:5, cha:6, int:4 },
    damageBonus: 15, defenseBonus: 8,
    equipped: { head:"Hood of Shadows", chest:"Rogue's Vest", mainHand:"Shadowfang", offHand:"", arms:"", legs:"" },
    inventory: [
      { id:"1", name:"Iron Dagger",    rarity:"Common",   type:"Weapon",    price:50  },
      { id:"2", name:"Serpent Ring",   rarity:"Uncommon", type:"Trinket",   price:200 },
      { id:"3", name:"Void Cloak",     rarity:"Rare",     type:"ChestArmor",price:850 },
      { id:"4", name:"Assassin Blade", rarity:"Epic",     type:"Weapon",    price:3200},
      { id:"5", name:"Lucky Coin",     rarity:"Common",   type:"Trinket",   price:30  },
    ],
    inventoryCount: 5,
    abilities: [
      { cmd:"quickstrike", name:"Quick Strike" },
      { cmd:"shadowstep",  name:"Shadow Step"  },
      { cmd:"backstab",    name:"Backstab"      },
      { cmd:"evasion",     name:"Evasion"       },
    ],
    pvpWins:7, pvpLosses:3,
    isDead:false, inCombat:false, isPlayerTurn:false, queuedAction:""
  });

  handleGlobalState({
    combatActive: true, isPlayerTurn: true,
    turnTimer: 32, expeditionActive: true,
    pvpActive: false, wave: 2, totalWaves: 3,
    shopRefresh: "4h 12m"
  });
}
