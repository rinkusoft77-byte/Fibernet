import { FALLBACK_TARIFFS, URLS } from "./config.js";

const SOURCE_LIST = [
  ["tariffs_tezkor", URLS.tezkor],
  ["tariffs_online", URLS.online],
  ["faq", URLS.faq],
  ["settings", URLS.settings],
  ["services", URLS.services],
  ["contacts_uz", URLS.contactsUz],
  ["contacts_ru", URLS.contactsRu]
];

export function htmlToText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&laquo;|&raquo;/gi, '"')
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function numeric(value) {
  return value ? Number(String(value).replace(/\D/g, "")) : null;
}

function candidateBlocks(text, name, allNames) {
  const blocks = [];
  let pos = 0;
  while ((pos = text.indexOf(name, pos)) !== -1) {
    let end = Math.min(text.length, pos + 2600);
    for (const other of allNames) {
      const p = text.indexOf(other, pos + name.length);
      if (p !== -1 && p < end) end = p;
    }
    blocks.push(text.slice(pos, end));
    pos += name.length;
  }
  return blocks;
}

export function parseTariffPage(text, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(`\\b${escaped}-\\d+\\b`, "gi");
  const names = [...new Set((text.match(nameRegex) || []).map(x => x.trim()))];
  const tariffs = [];

  for (const name of names) {
    const blocks = candidateBlocks(text, name, names);
    let parsed = null;
    for (const block of blocks) {
      const price = block.match(/(?:Narxi|Стоимость)\s*([\d\s]+)\s*(?:so['’]?m|сум)/i);
      const evening = block.match(/(?:18:00\s*dan\s*00:00\s*gacha|с\s*18:00\s*до\s*00:00)[\s\S]{0,100}?(\d+)\s*(?:Mbit\/s|Мбит\/с)/i);
      const daytime = block.match(/(?:00:00\s*dan\s*18:00\s*gacha|с\s*00:00\s*до\s*18:00)[\s\S]{0,100}?(\d+)\s*(?:Mbit\/s|Мбит\/с)/i);
      const tasix = block.match(/(?:TAS-IX[^\n]*|Скорость\s*TAS-IX)[\s\S]{0,80}?(\d+)\s*(?:Mbit\/s|Мбит\/с)/i);
      const router = block.match(/(?:Router ijarasi|Роутер в аренду)\s*([^\n]{1,50})/i);
      const tv = block.match(/(?:TV|ТВ)\s*(\d+)\s*(?:ta telekanallar|Канал|Каналов|каналов)/i);
      if (price && (evening || daytime)) {
        parsed = {
          name,
          price: numeric(price[1]),
          evening: numeric(evening?.[1]),
          daytime: numeric(daytime?.[1]),
          tasix: numeric(tasix?.[1]),
          router: router?.[1]?.trim() || null,
          tv: tv?.[1] || null
        };
        break;
      }
    }
    if (parsed) tariffs.push(parsed);
  }

  return tariffs.sort((a, b) => (a.price || 0) - (b.price || 0));
}

async function storeSource(env, key, url, status, content) {
  await env.DB.prepare(`
    INSERT INTO source_cache(source_key, url, http_status, content, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      url=excluded.url, http_status=excluded.http_status, content=excluded.content, fetched_at=excluded.fetched_at
  `).bind(key, url, status, content.slice(0, 120000), new Date().toISOString()).run();
}

async function storeCatalog(env, key, payload, sourceUrl) {
  await env.DB.prepare(`
    INSERT INTO catalog(catalog_key, payload, source_url, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(catalog_key) DO UPDATE SET
      payload=excluded.payload, source_url=excluded.source_url, updated_at=excluded.updated_at
  `).bind(key, JSON.stringify(payload), sourceUrl, new Date().toISOString()).run();
}

export async function syncOfficialSources(env) {
  const report = [];
  for (const [key, url] of SOURCE_LIST) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "FiberNetSupportBot/1.0 (+https://fibernet.uz)",
          "accept": "text/html,application/xhtml+xml"
        },
        redirect: "follow"
      });
      const html = await res.text();
      const text = htmlToText(html);
      await storeSource(env, key, url, res.status, text);

      if (res.ok && key === "tariffs_tezkor") {
        const parsed = parseTariffPage(text, "TEZKOR");
        if (parsed.length >= 3) await storeCatalog(env, "tariffs_tezkor", parsed, url);
        report.push({ key, status: res.status, parsed: parsed.length });
      } else if (res.ok && key === "tariffs_online") {
        const parsed = parseTariffPage(text, "OnLine");
        if (parsed.length >= 3) await storeCatalog(env, "tariffs_online", parsed, url);
        report.push({ key, status: res.status, parsed: parsed.length });
      } else {
        report.push({ key, status: res.status });
      }
    } catch (err) {
      report.push({ key, status: 0, error: String(err).slice(0, 180) });
    }
  }
  return report;
}

export async function getTariffs(env, series) {
  const key = series === "tezkor" ? "tariffs_tezkor" : "tariffs_online";
  try {
    const row = await env.DB.prepare("SELECT payload FROM catalog WHERE catalog_key = ?").bind(key).first();
    if (row?.payload) {
      const parsed = JSON.parse(row.payload);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {}
  return FALLBACK_TARIFFS[series] || [];
}

export async function getSourceStatus(env) {
  const result = await env.DB.prepare(`
    SELECT source_key, http_status, fetched_at FROM source_cache ORDER BY source_key
  `).all();
  return result.results || [];
}
