// Run with: node stampede-checker.mjs
// Node 18+ (GitHub Actions already has this)

// ====== CONFIG ======
const ORG    = "b2706404-e8f5-4e57-986d-0769e149bad0";
const SERIAL = "GJRPJ1VIUNLJ";
const PS     = 2;                    // party size
const TZ     = "Europe/London";      // show times in UK time
const DAYS   = 90;                   // how far ahead to scan
const ONLY_TYPES = [];               // leave [] to include all

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const PROXY_URL = process.env.HTTPS_PROXY;

// ====== HELPERS ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fmtUKDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: TZ
  });

const parseTime = (isoDate, v) => {
  if (!v) return null;
  const raw = typeof v === "object"
    ? (v.time ?? v.label ?? v.start ?? v.starts_at ?? v.datetime ?? v.value ?? v.slot)
    : v;
  if (!raw) return null;

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
  slot?.type?.name ?? slot?.booking_type?.name ?? slot?.category?.name ??
  slot?.booking_type_name ?? slot?.type ?? null;

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
  if (!DISCORD_WEBHOOK) {
    console.error("No Discord webhook configured.");
    return;
  }
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
    const options = { headers: { "accept": "application/json" } };
    const res = await fetch(u, options);
    if (!res.ok) return [];
    const data = await res.json();

    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.times)) return data.times;
    if (Array.isArray(data?.slots)) return data.slots;
    const candidate = Object.values(data).find(v => Array.isArray(v));
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

    let filtered = slots;
    if (ONLY_TYPES.length) {
      filtered = slots.filter(s => {
        const tn = getTypeName(s);
        return tn && ONLY_TYPES.includes(String(tn));
      });
      if (!filtered.length) continue;
    }

    const typeNames = uniq(filtered.map(getTypeName).map(x => x ?? "_"));
    for (const tn of typeNames) {
      const bucket = filtered.filter(s => (getTypeName(s) ?? "_") === tn);
      const timesUK = bucket
        .map(s => parseTime(d, s))
        .filter(Boolean)
        .sort((a,b)=>a-b)
        .map(dt => dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }));

      if (timesUK.length)
        allAvail.push({ dateUK: fmtUKDate(d), type: tn || "General", times: uniq(timesUK).join(", ") });
    }

    await sleep(200);
  }

  if (!allAvail.length) {
    console.log("No availability found.");
    await sendDiscord(`❌ No availability found for the next ${DAYS} days (party size ${PS}).`);
    return;
  }

  let message = `🎟️ **Availability Found (Party size ${PS})**\n`;
  for (const a of allAvail)
    message += `**${a.dateUK}** — ${a.times}${a.type && a.type !== "_" ? ` (${a.type})` : ""}\n`;

  console.table(allAvail);
  await sendDiscord(message);
})();
