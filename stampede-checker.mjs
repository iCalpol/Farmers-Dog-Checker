// Node 18+
// Pings only when NEW slots appear (per-date, per-time, per-type). Persists state in lastSeen.json.
// Sends "Still running ✅" every 4 hours.

const ORG    = "b2706404-e8f5-4e57-986d-0769e149bad0";
const SERIAL = "GJRPJ1VIUNLJ";
const PS     = 2;
const TZ     = "Europe/London";
const DAYS   = 90;

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

import fs from "fs";

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

// ---------- discord ----------
async function sendDiscordEmbed(title, lines, ping = false, color = 0x4caf50) {
  if (!DISCORD_WEBHOOK) return console.error("⚠️ Missing Discord webhook.");
  const payload = {
    content: ping ? "@here" : undefined, // set true to ping @here
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

// ---------- main ----------
(async () => {
  const dates = dateRange(DAYS);

  // Build a flat list of *entries* (per slot time), so we can diff precisely.
  // entryKey format: `${isoDate}|${type || "_"}|${timeHH:MM}`
  const entries = []; // { isoDate, dateUK, type, timeHM, slotsLeft }
  for (const d of dates) {
    const slots = await timesForDate(d);
    if (!slots.length) continue;

    for (const s of slots) {
      const dt = parseTime(d, s);
      if (!dt) continue;

      const timeHM = dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
      const type = getTypeName(s) ?? "_";
      const slotsLeft = typeof s?.slots_left === "number" ? s.slots_left : undefined;

      entries.push({
        isoDate: d,
        dateUK: fmtUKDate(d),
        type,
        timeHM,
        slotsLeft,
      });
    }
  }

  // Current set of keys
  const currentKeys = new Set(entries.map(e => `${e.isoDate}|${e.type}|${e.timeHM}`));

  // Load last seen keys
  const stateFile = "lastSeen.json";
  let lastKeys = new Set();
  if (fs.existsSync(stateFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (Array.isArray(raw?.keys)) lastKeys = new Set(raw.keys);
    } catch {
      // ignore corrupt state; treat as empty
      lastKeys = new Set();
    }
  }

  // NEW items since the previous run (these are the only ones we’ll ping for)
  const newKeys = [...currentKeys].filter(k => !lastKeys.has(k));

  // Optional: detect "all disappeared" (went from something -> nothing)
  const disappeared = lastKeys.size > 0 && currentKeys.size === 0;

  // Save state for next run (overwrite with current snapshot)
  fs.writeFileSync(stateFile, JSON.stringify({ keys: [...currentKeys] }, null, 2));

  // 4-hour keepalive
  const now = new Date();
  const shouldKeepAlive = (now.getHours() % 4 === 0 && now.getMinutes() < 5);

  if (newKeys.length) {
    // Create lines grouped by date/type, but only for NEW keys
    const newSet = new Set(newKeys);
    const byDateType = new Map(); // key = `${dateUK}|${type}`, val = [times...]
    for (const e of entries) {
      const k = `${e.isoDate}|${e.type}|${e.timeHM}`;
      if (!newSet.has(k)) continue;
      const labelKey = `${e.dateUK}|${e.type}`;
      if (!byDateType.has(labelKey)) byDateType.set(labelKey, []);
      const tag = e.slotsLeft !== undefined ? ` [${e.slotsLeft} left]` : "";
      byDateType.get(labelKey).push(e.timeHM + tag);
    }

    const lines = [];
    for (const [labelKey, times] of byDateType.entries()) {
      const [dateUK, type] = labelKey.split("|");
      const suffix = (type && type !== "_") ? ` (${type})` : "";
      // sort and uniq times
      const uniqTimes = [...new Set(times)].sort();
      lines.push(`${dateUK} — ${uniqTimes.join(", ")}${suffix}`);
    }

    console.log("🎟️ New slots:", lines);
    await sendDiscordEmbed(`🎟️ New availability (Party size ${PS})`, lines, true, 0x00ff66);
  } else if (disappeared) {
    // Comment out this whole block if you don't want "all gone" pings
    console.log("❌ All availability disappeared.");
    await sendDiscordEmbed("❌ All availability removed", ["Everything booked or unavailable."], false, 0xff0000);
  } else if (shouldKeepAlive) {
    const msg = `✅ Still running at ${now.toLocaleTimeString("en-GB", { timeZone: TZ })}`;
    console.log(msg);
    await sendDiscordEmbed("Keepalive ✅", [msg], false, 0x2196f3);
  } else {
    console.log("No NEW slots. Still monitoring...");
  }
})();
