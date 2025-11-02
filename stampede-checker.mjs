
// Node 18+
// Diff-style alerts: only ping when slots are ADDED or REMOVED.
// Readable Discord embeds, grouped by date & type. Persist state in lastSeen.json.
// Sends a keepalive every 4 hours. De-dupes identical notifications for 2 mins.

const ORG    = "b2706404-e8f5-4e57-986d-0769e149bad0";
const SERIAL = "GJRPJ1VIUNLJ";
const PS     = 2;
const TZ     = "Europe/London";
const DAYS   = 90;

// ---- behaviour ----
const DEDUPE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

import fs from "fs";
import crypto from "crypto";

// ---------- helpers ----------
const fmtUKDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: TZ
  });

const parseTime = (isoDate, v) => {
  if (!v) return null;
  const raw = typeof v === "object"
    ? (v.start_time ?? v.time ?? v.label ?? v.start ?? v.startTime ?? v.starts_at ?? v.startsAt ?? v.datetime ?? v.value ?? v.slot)
    : v;
  if (raw == null) return null;

  if (typeof raw === "number") return new Date(raw > 1e12 ? raw : raw * 1000);

  const s = String(raw).trim();
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const hhmmss = s.length === 5 ? `${s}:00` : s;
    return new Date(`${isoDate}T${hhmmss}Z`);
  }
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(s) ? (s.endsWith("Z") ? s : s + "Z") : s;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
};

const getTypeName = (slot) =>
  slot?.booking_type_name ??
  slot?.type?.name ??
  slot?.booking_type?.name ??
  slot?.category?.name ??
  slot?.category ??
  slot?.type ?? null;

const dateRange = (days) => {
  const out = [];
  const now = new Date();
  now.setUTCHours(0,0,0,0);
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const slotKey = (isoDate, type, timeHM) => `${isoDate}|${type}|${timeHM}`;

// ---------- discord ----------
async function sendEmbed({ title, lines, color }) {
  if (!DISCORD_WEBHOOK) return console.error("⚠️ Missing DISCORD_WEBHOOK");
  const payload = {
    embeds: [{
      title,
      description: lines.join("\n").slice(0, 1990),
      color,
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Discord send failed:", e.message);
  }
}

// ---------- network ----------
async function timesForDate(isoDate) {
  const u = new URL("https://booking.stampede.ai/api/v2/times");
  u.searchParams.set("org_id", ORG);
  u.searchParams.set("serial", SERIAL);
  u.searchParams.set("date", isoDate);
  u.searchParams.set("party_size", String(PS));
  try {
    const res = await fetch(u, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.times)) return data.times;
    if (Array.isArray(data?.slots)) return data.slots;
    const candidate = data && typeof data === "object"
      ? Object.values(data).find((v) => Array.isArray(v))
      : null;
    return Array.isArray(candidate) ? candidate : [];
  } catch (err) {
    console.error("Fetch failed for", isoDate, err.message);
    return [];
  }
}

// Group slot entries into readable lines
function groupLinesFromKeys(keys, metaMap) {
  const byLabel = new Map(); // label => Set(times)
  for (const k of keys) {
    const m = metaMap.get(k);
    if (!m) continue;
    const label = `${m.dateUK}|${m.type}`;
    if (!byLabel.has(label)) byLabel.set(label, new Set());
    const tag = typeof m.slotsLeft === "number" ? ` [${m.slotsLeft} left]` : "";
    byLabel.get(label).add(m.timeHM + tag);
  }
  const lines = [];
  const labels = [...byLabel.keys()].sort();
  for (const label of labels) {
    const [dateUK, type] = label.split("|");
    const suffix = (type && type !== "_") ? ` (${type})` : "";
    const times = [...byLabel.get(label)].sort();
    lines.push(`• **${dateUK}** — ${times.join(", ")}${suffix}`);
  }
  return lines;
}

// ---------- main ----------
(async () => {
  const dates = dateRange(DAYS);
  const meta = new Map();
  const currentKeys = new Set();

  for (const d of dates) {
    const slots = await timesForDate(d);
    if (!slots.length) continue;
    for (const s of slots) {
      const dt = parseTime(d, s);
      if (!dt) continue;
      const timeHM   = dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
      const type     = getTypeName(s) ?? "_";
      const slotsLeft = typeof s?.slots_left === "number" ? s.slots_left : undefined;
      const key = slotKey(d, type, timeHM);
      currentKeys.add(key);
      if (!meta.has(key)) {
        meta.set(key, { isoDate: d, dateUK: fmtUKDate(d), type, timeHM, slotsLeft });
      }
    }
  }

  const stateFile = "lastSeen.json";
  let state = { keys: [], lastHash: "", lastSentAt: 0 };
  if (fs.existsSync(stateFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      state = { ...state, ...raw };
    } catch {}
  }

  const previousKeys = new Set(state.keys || []);
  const addedKeys   = [...currentKeys].filter(k => !previousKeys.has(k));
  const removedKeys = [...previousKeys].filter(k => !currentKeys.has(k));

  const addedLines   = groupLinesFromKeys(addedKeys, meta);
  const removedLines = groupLinesFromKeys(removedKeys, meta);

  const payloadForHash = JSON.stringify({ added: addedLines, removed: removedLines });
  const notifHash = crypto.createHash("sha1").update(payloadForHash).digest("hex");
  const nowMs     = Date.now();
  const withinCooldown = (nowMs - (state.lastSentAt || 0)) < DEDUPE_COOLDOWN_MS;

  state.keys = [...currentKeys];
  const now = new Date();
  const shouldKeepAlive = (now.getHours() % 4 === 0 && now.getMinutes() < 5);

  const somethingAdded   = addedLines.length > 0;
  const somethingRemoved = removedLines.length > 0;

  if (somethingAdded || somethingRemoved) {
    if (state.lastHash === notifHash && withinCooldown) {
      console.log("Duplicate diff within cooldown — skipping send.");
    } else {
      if (somethingAdded) {
        await sendEmbed({
          title: `🟢 New availability (Party size ${PS})`,
          lines: addedLines,
          color: 0x00c853
        });
      }
      if (somethingRemoved) {
        await sendEmbed({
          title: `🔴 Removed availability (Party size ${PS})`,
          lines: removedLines,
          color: 0xff1744
        });
      }
      state.lastHash   = notifHash;
      state.lastSentAt = nowMs;
    }
  } else if (shouldKeepAlive) {
    const msg = `Still running at ${now.toLocaleTimeString("en-GB", { timeZone: TZ })}`;
    await sendEmbed({
      title: "✅ Keepalive",
      lines: [msg],
      color: 0x2196f3
    });
  } else {
    console.log("No changes. Still monitoring...");
  }

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
})();
