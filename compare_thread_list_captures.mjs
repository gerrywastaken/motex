#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);

if (files.length < 1 || files.length > 2) {
  console.error("Usage: node compare_thread_list_captures.mjs <capture.json> [other-capture.json]");
  process.exit(2);
}

const summaries = files.map((file) => summarizeCapture(file));

for (const summary of summaries) {
  printSummary(summary);
}

if (summaries.length === 2) {
  printDiff(summaries[0], summaries[1]);
}

function summarizeCapture(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const message = unwrapThreadList(raw);
  if (!message) throw new Error(`${file} is not a thread/list request or response capture`);

  const rows = Array.isArray(message.result?.data) ? message.result.data : [];
  const fieldCounts = new Map();
  const statusTypes = new Map();
  const statusKeys = new Map();
  const sourceValues = new Map();
  const projectNames = new Map();
  let missingNames = 0;

  for (const row of rows) {
    for (const key of Object.keys(row).sort()) {
      increment(fieldCounts, key);
    }

    if (typeof row.name !== "string" || !row.name.trim()) missingNames += 1;

    const status = row.status;
    if (status && typeof status === "object") {
      increment(statusTypes, String(status.type ?? "<missing>"));
      for (const key of Object.keys(status).sort()) {
        increment(statusKeys, key);
      }
    }

    for (const value of sourceLabels(row)) {
      increment(sourceValues, value);
    }

    const cwd = String(row.cwd ?? "");
    const project = cwd.split(/[\\/]/).filter(Boolean).at(-1);
    if (project) increment(projectNames, project);
  }

  return {
    file,
    kind: message.method === "thread/list" ? "request" : "response",
    id: message.id ?? null,
    method: message.method ?? null,
    params: message.params ?? null,
    rowCount: rows.length,
    missingNames,
    fieldCounts: Object.fromEntries(fieldCounts),
    statusTypes: Object.fromEntries(statusTypes),
    statusKeys: Object.fromEntries(statusKeys),
    sourceValues: Object.fromEntries(sourceValues),
    projectNames: Object.fromEntries(projectNames),
  };
}

function unwrapThreadList(value) {
  if (isThreadListMessage(value)) return value;
  if (isThreadListMessage(value?.message)) return value.message;
  return null;
}

function isThreadListMessage(value) {
  if (!value || typeof value !== "object") return false;
  if (value.method === "thread/list") return true;
  return Array.isArray(value.result?.data);
}

function sourceLabels(row) {
  const labels = [];
  for (const key of ["source", "sourceKind", "source_kind"]) {
    if (row[key] !== undefined) labels.push(`${key}:${String(row[key])}`);
  }
  if (Array.isArray(row.sources)) {
    for (const source of row.sources) labels.push(`sources:${String(source)}`);
  }
  if (labels.length === 0) labels.push("<none>");
  return labels;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printSummary(summary) {
  console.log(`\n== ${path.basename(summary.file)} ==`);
  console.log(`kind: ${summary.kind}`);
  console.log(`id: ${summary.id ?? "<none>"}`);
  if (summary.kind === "request") {
    console.log(`method: ${summary.method}`);
    console.log(`params: ${JSON.stringify(summary.params ?? null)}`);
    return;
  }

  console.log(`rows: ${summary.rowCount}`);
  console.log(`missing names: ${summary.missingNames}`);
  printMap("status types", summary.statusTypes);
  printMap("status keys", summary.statusKeys);
  printMap("sources", summary.sourceValues);
  printMap("row fields", summary.fieldCounts);
}

function printMap(label, values) {
  console.log(`${label}: ${formatMap(values)}`);
}

function formatMap(values) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "<none>";
  return entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function printDiff(left, right) {
  console.log(`\n== diff ${path.basename(left.file)} -> ${path.basename(right.file)} ==`);
  if (left.kind !== right.kind) {
    console.log(`kind: ${left.kind} -> ${right.kind}`);
    return;
  }

  if (left.kind === "request") {
    compareJson("params", left.params, right.params);
    return;
  }

  compareValue("rows", left.rowCount, right.rowCount);
  compareValue("missing names", left.missingNames, right.missingNames);
  compareMap("status types", left.statusTypes, right.statusTypes);
  compareMap("status keys", left.statusKeys, right.statusKeys);
  compareMap("sources", left.sourceValues, right.sourceValues);
  compareMap("row fields", left.fieldCounts, right.fieldCounts);
}

function compareValue(label, left, right) {
  if (left !== right) console.log(`${label}: ${left} -> ${right}`);
}

function compareJson(label, left, right) {
  const leftText = JSON.stringify(left ?? null);
  const rightText = JSON.stringify(right ?? null);
  if (leftText !== rightText) console.log(`${label}: ${leftText} -> ${rightText}`);
}

function compareMap(label, left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changes = [];
  for (const key of [...keys].sort()) {
    const leftValue = left[key] ?? 0;
    const rightValue = right[key] ?? 0;
    if (leftValue !== rightValue) changes.push(`${key}:${leftValue}->${rightValue}`);
  }
  if (changes.length) console.log(`${label}: ${changes.join(", ")}`);
}
