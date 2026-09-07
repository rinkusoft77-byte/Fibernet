import test from "node:test";
import assert from "node:assert/strict";
import { htmlToText, parseTariffPage } from "../src/catalog.js";

test("htmlToText strips scripts and tags", () => {
  const out = htmlToText(`<h1>TEZKOR</h1><script>alert(1)</script><p>Narxi 160 000 so'm</p>`);
  assert.match(out, /TEZKOR/);
  assert.match(out, /160 000/);
  assert.doesNotMatch(out, /alert/);
});

test("parseTariffPage extracts Uzbek tariff blocks", () => {
  const text = `
TEZKOR-100
Narxi 160 000 so'm
Kirish tezligi 18:00 dan 00:00 gacha 100 Mbit/s
Kirish tezligi 00:00 dan 18:00 gacha 200 Mbit/s
TAS-IX va tarmoq ichida 200 Mbit/s
Router ijarasi 25 000 so'm/oy
TV 170 ta telekanallar
TEZKOR-200
Narxi 200 000 so'm
Kirish tezligi 18:00 dan 00:00 gacha 200 Mbit/s
Kirish tezligi 00:00 dan 18:00 gacha 200 Mbit/s
TAS-IX va tarmoq ichida 200 Mbit/s
`;
  const rows = parseTariffPage(text, "TEZKOR");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name.toUpperCase(), "TEZKOR-100");
  assert.equal(rows[0].price, 160000);
  assert.equal(rows[0].evening, 100);
  assert.equal(rows[0].daytime, 200);
  assert.equal(rows[1].price, 200000);
});
