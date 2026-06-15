// On-demand player spotlight — Netlify Function (v2).
// Design: cache per player per stat-state, roster-only input, hard daily ceiling.
// The API key lives in an env var (Netlify → Site config → Environment variables) and is
// never exposed to the browser. Reads CLAUDE_API_KEY (or ANTHROPIC_API_KEY as a fallback).
import { getStore } from "@netlify/blobs";

const MODEL      = "claude-haiku-4-5-20251001"; // cheap + plenty for a 2–3 sentence blurb
const MAX_TOKENS = 160;                          // hard bound on output cost per call
const DAILY_CAP  = 300;                          // max live Claude calls/day (approx); caps worst-case spend
const TEAM       = "Base Invaders";

export default async (request) => {
  const url  = new URL(request.url);
  const want = (url.searchParams.get("player") || "").trim();
  if (!want) return json({ error: "missing player" }, 400);

  // Authoritative roster + stats from our own published data.json (never trust client stats)
  const site = process.env.URL || `https://${request.headers.get("host")}`;
  let data;
  try {
    const res = await fetch(site + "/data.json", { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error("status " + res.status);
    data = await res.json();
  } catch (e) {
    return json({ error: "data unavailable" }, 502);
  }

  const players = Array.isArray(data.players) ? data.players : [];
  // Roster-only validation: the request must name a real player. Everything else is rejected,
  // which neuters prompt-injection and "free Claude proxy" abuse — there's no free-form input.
  const player = players.find(p => String(p.name).toLowerCase() === want.toLowerCase());
  if (!player) return json({ error: "unknown player" }, 404);

  const store = getStore("spotlights");
  const key   = "sp:" + player.name.toLowerCase() + ":" + statHash(player);

  // 1) Cache hit → free, instant. (Floods of taps land here, not on Claude.)
  try {
    const cached = await store.get(key);
    if (cached) return json({ name: player.name, spotlight: cached, cached: true });
  } catch (_) {}

  // 2) Daily ceiling → if exhausted, serve a deterministic no-AI blurb and stop.
  const capKey = "calls:" + new Date().toISOString().slice(0, 10); // UTC day
  let used = 0;
  try { used = parseInt((await store.get(capKey)) || "0", 10) || 0; } catch (_) {}
  if (used >= DAILY_CAP) {
    return json({ name: player.name, spotlight: fallbackBlurb(player), cached: false, capped: true });
  }

  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ name: player.name, spotlight: fallbackBlurb(player), cached: false });

  // 3) Generate once. Prompt is built from SERVER-side stats + the roster-sourced name only.
  const line = `${player.gp} GP, ${player.ab} AB, ${player.h} H, ${player.hr} HR, ` +
               `${player.rbi} RBI, ${player.r} R, ${fmt3(player.avg)} AVG, ${fmt3(player.ops)} OPS`;
  const rank = bestRank(players, player.name);
  const prompt =
    `Write a 2–3 sentence player spotlight for ${player.name} of the ${TEAM}, a rec co-ed slo-pitch ` +
    `softball team. Upbeat and specific, third person, plain text, no headline, no emojis. Work in their ` +
    `best number naturally. Under 55 words.\n` +
    `Stat line: ${line}\n` +
    (rank ? `Team rank: ${rank}\n` : "");

  let text = "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }] })
    });
    if (r.ok) {
      const j = await r.json();
      const block = (j.content || []).find(b => b.type === "text");
      text = block && block.text ? block.text.trim() : "";
    }
  } catch (_) {}

  if (!text) return json({ name: player.name, spotlight: fallbackBlurb(player), cached: false });

  // Cache the result and bump the daily counter (cap is approximate under bursts — acceptable here).
  try { await store.set(key, text); } catch (_) {}
  try { await store.set(capKey, String(used + 1)); } catch (_) {}

  return json({ name: player.name, spotlight: text, cached: false });
};

// ---- helpers ----
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
function fmt3(v) { return (v == null) ? "—" : Number(v).toFixed(3); }

// Stable short hash of the stat-state, so a new blurb is generated only when stats change.
function statHash(p) {
  const s = [p.gp, p.ab, p.h, p.hr, p.rbi, p.r, p.avg, p.ops].join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function bestRank(players, name) {
  const metrics = [["OPS", "ops"], ["AVG", "avg"], ["RBI", "rbi"], ["Hits", "h"], ["HR", "hr"], ["Runs", "r"]];
  let best = null;
  for (const [lab, key] of metrics) {
    if (key === "hr" && !(players.find(p => p.name === name) || {}).hr) continue;
    const sorted = players.filter(p => p[key] != null).sort((a, b) => b[key] - a[key]);
    const i = sorted.findIndex(p => p.name === name);
    if (i >= 0 && i < 3 && (!best || i + 1 < best.r)) best = { r: i + 1, t: "#" + (i + 1) + " " + lab };
  }
  return best ? best.t + " on the team" : "";
}

function fallbackBlurb(p) {
  const bits = [];
  if (p.hr)  bits.push(`${p.hr} bomb${p.hr > 1 ? "s" : ""}`);
  if (p.rbi) bits.push(`${p.rbi} RBI`);
  if (p.h)   bits.push(`${p.h} hit${p.h > 1 ? "s" : ""}`);
  const tail = bits.length ? ` with ${bits.slice(0, 2).join(" and ")}` : "";
  return `${p.name} has been putting in work for the ${TEAM}${tail}, hitting ${fmt3(p.avg)} ` +
         `with a ${fmt3(p.ops)} OPS across ${p.gp} game${p.gp === 1 ? "" : "s"}.`;
}
