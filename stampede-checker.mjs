// Node 18+ compatible (works with GitHub Actions)
// Checks Stampede API for availability, pings Discord only when stock changes,
// and sends a "Still running ✅" ping every 4 hours.

// ====== CONFIG ======
const ORG    = "b2706404-e8f5-4e57-986d-0769e149bad0";
const SERIAL = "GJRPJ1VIUNLJ";
const PS     = 2;                    // party size
const TZ     = "Europe/London";      // timezone for messages
const DAYS   = 90;                   // how far ahead to scan

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const PROXY_URL = process.env.HTTPS_PROXY;

// ====== HELPERS ======
import fs from "fs";

const fmtUKDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: TZ
  });

const parseTime = (isoDate, v) => {
  if (!v) return null;

  // Pull a time-like field from a slot object or value.
  const raw = typeof v === "object"
    ? (
        v.time ??
        v.label ??
        v.start ??                 // some APIs
        v.start_time ??            // <-- Stampede returns this
        v.starts_at ??             // snake case alt
        v.startsAt ??
        v.startTime ??             // camelCase alt
        v.datetime ??
        v.value ??
        v.slot
      )
    : v;

  if (raw == null) return null;

  if (typeof raw === "number") {
    // seconds vs ms
    return new Date(raw > 1e12 ? raw : raw * 1000);
  }

  const s = String(raw).trim();

  // Plain "HH:MM" or "HH:MM:SS" — assume it's UTC-ish as the API behaves.
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const hhmmss = s.length === 5 ? `${s}:00` : s;
    return new Date(`${isoDate}T${hhmmss}Z`);
  }

  // If it looks like an ISO datetime but without Z, append Z.
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(s) ? (s.endsWith("Z") ? s : s + "Z") : s;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
};

// Try to extract a "type" for grouping if present
const getTypeName = (slot) =>
  slot?.type?.name ??
  slot?.booking_type?.name ??
  slot?.bookingType?.name ??
  slot?.booking_type_name ??      // present in your sample
  slot?.category?.name ??
  slot?.category ??
  slot?.type ??
  null;

const uniq = (arr) => [...new Set(arr)];

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

async function sendDiscord(content) {
  if (!DISCORD_WEBHOOK) return console.error("⚠️ Missing Discord webhook.");
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    console.error("Discord send failed:", e.message);
  }
}

// ====== NETWORK ======
async function timesForDate(isoDate) {
  const u = new URL("https://booking.stampede.ai/api/v2/times");
  u.searchParams.set("org_id", ORG);
  u.searchParams.set("serial", SERIAL);
  u.searchParams.set("date", isoDate);
  u.searchParams.set("party_size", String(PS));

  try {
    const res = await fetch(u, { headers: { "accept": "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();

    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.times)) return data.times;
    if (Array.isArray(data?.slots)) return data.slots;

    const candidate = data && typeof data === "object"
      ? Object.values(data).find(v => Array.isArray(v))
      : null;
    return Array.isArray(candidate) ? candidate : [];
  } catch (err) {
    console.error("Fetch failed for", isoDate, err.message);
    return [];
  }
}

// ====== MAIN ======
(async () => {
  const dates = dateRange(DAYS);
  const allAvail = [];

  for (const d of dates) {
    const slots = await timesForDate(d);
    if (!slots.length) continue;

    const typeNames = uniq(slots.map(getTypeName).map(x => x ?? "_"));

    for (const tn of typeNames) {
      const bucket = slots.filter(s => (getTypeName(s) ?? "_") === tn);
      const timesUK = bucket
        .map(s => parseTime(d, s))
        .filter(Boolean)
        .sort((a,b)=>a-b)
        .map(dt => dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }));

      if (timesUK.length) {
        allAvail.push({
          dateUK: fmtUKDate(d),
          type: tn || "General",
          times: uniq(timesUK).join(", ")
        });
      }
    }
  }

  // Snapshot for change detection
  const newSnapshot = JSON.stringify(allAvail, null, 2);

  // ====== LOAD/SAVE SNAPSHOT (works with Actions cache steps) ======
  const lastFile = "./last.json";
  let oldSnapshot = "";
  if (fs.existsSync(lastFile)) {
    oldSnapshot = fs.readFileSync(lastFile, "utf8");
  }
  fs.writeFileSync(lastFile, newSnapshot);

  const changed = newSnapshot !== oldSnapshot;

  // 4-hour keepalive window
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const shouldKeepAlive = (hours % 4 === 0 && minutes < 5);

  if (changed && allAvail.length) {
    let msg = `🎟️ **New availability found (Party size ${PS})**\n`;
    for (const a of allAvail) {
      msg += `**${a.dateUK}** — ${a.times}${a.type && a.type !== "_" ? ` (${a.type})` : ""}\n`;
    }
    console.log("New availability found:", allAvail);
    await sendDiscord(msg);
  } else if (!allAvail.length && changed) {
    console.log("Availability disappeared.");
    await sendDiscord("❌ All availability has been booked or removed.");
  } else if (shouldKeepAlive) {
    const msg = `✅ Still running at ${now.toLocaleTimeString("en-GB", { timeZone: TZ })}`;
    console.log(msg);
    await sendDiscord(msg);
  } else {
    console.log("No changes detected. Still monitoring...");
  }
})();
