import test from "node:test";
import assert from "node:assert/strict";
import { classifyText, inferPriority, normalizePhone, stageLabel } from "../src/portal-ui.js";

test("normalizes Uzbekistan contact formats", () => {
  assert.equal(normalizePhone("+998 90 138 18 04"), "+998901381804");
  assert.equal(normalizePhone("90 138 18 04"), "+998901381804");
  assert.equal(normalizePhone("0901381804"), "+998901381804");
});

test("accepts Telegram contact style without plus", () => {
  assert.equal(normalizePhone("998901381804"), "+998901381804");
});

test("routes free text to the right department", () => {
  assert.deepEqual(classifyText("wifi uzilib qolmoqda"), { action: "ticket", department: "tech", category: "wifi" });
  assert.deepEqual(classifyText("to'lov tushmadi"), { action: "ticket", department: "accounting", category: "payment_missing" });
  assert.deepEqual(classifyText("yangi ulanish kerak"), { action: "ticket", department: "connection", category: "connection" });
  assert.deepEqual(classifyText("tariflar"), { action: "tariffs" });
});

test("critical optical symptoms are escalated", () => {
  assert.equal(inferPriority("no_internet", "ONU LOS qizil"), "critical");
  assert.equal(inferPriority("no_internet", "internet yo'q"), "high");
});

test("stage labels are bilingual", () => {
  assert.equal(stageLabel("in_progress", "uz"), "Jarayonda");
  assert.equal(stageLabel("waiting_customer", "ru"), "Ожидается ответ клиента");
});
