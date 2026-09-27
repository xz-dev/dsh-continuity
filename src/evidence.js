// dsh-continuity evidence machinery: port of pi-continuity internal/continuity-evidence.ts.
//
// Pi addresses raw user text by session entry id; DSH addresses it by durable
// session-event seq. Everything else — exact-span verification, sha256
// identities, source windows, carry/retire semantics, coverage counters — is a
// direct behavioral port.

import { createHash } from "node:crypto";

const KINDS = ["task", "acceptance", "constraint", "correction"];
const MAX_QUOTE = 1200;
const MAX_SELECTIONS = 32;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value) {
  return KINDS.includes(value);
}

function blockKey(entryId, blockIndex) {
  return JSON.stringify([entryId, blockIndex]);
}

function identify(block, start, end, kind) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > block.text.length || end - start > MAX_QUOTE) return undefined;
  const text = block.text.slice(start, end);
  // In Unicode mode this matches lone surrogates, not intact surrogate pairs.
  if (/[\uD800-\uDFFF]/u.test(text)) return undefined;
  const id = createHash("sha256").update(JSON.stringify([block.entryId, block.blockIndex, start, end, text])).digest("hex");
  return { reference: { id, entryId: block.entryId, blockIndex: block.blockIndex, start, end, kind }, text, branchOrder: block.branchOrder };
}

function coveredLength(ranges) {
  let length = 0;
  let end = 0;
  for (const [start, nextEnd] of ranges.sort((a, b) => a[0] - b[0])) {
    length += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return length;
}

// Parse a rendered "## Original user evidence" section back into candidate
// references. Returns undefined when the section is absent or malformed
// (native/legacy checkpoint → basis "rebuilt", never borrowed).
export function parseRenderedEvidence(summaryText) {
  if (typeof summaryText !== "string") return undefined;
  const start = summaryText.indexOf('## Original user evidence\n');
  const end = summaryText.indexOf('\n## ', start + 4);
  const section = start >= 0 && end > start ? summaryText.slice(start, end) : undefined;
  const coverage = summaryText.match(/^## Retention coverage\n(\{[^\n]*\})/m);
  if (!section || !coverage) return undefined;
  try {
    const parsed = JSON.parse(coverage[1]);
    if (!isRecord(parsed) || parsed.mode !== "selected") return undefined;
  } catch {
    return undefined;
  }
  const refs = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^- (task|acceptance|constraint|correction) ([^:\s]+):(\d+):(\d+)-(\d+) \[([0-9a-f]{64})\]: (".*")$/);
    if (!match) continue;
    let text;
    try {
      text = JSON.parse(match[7]);
    } catch {
      continue;
    }
    if (typeof text !== "string") continue;
    refs.push({ kind: match[1], entryId: match[2], blockIndex: Number(match[3]), start: Number(match[4]), end: Number(match[5]), id: match[6], text });
  }
  return refs;
}

// Collect raw user text blocks from the live surface plus carried-reference
// targets from the durable log. `surfaceUserBlocks(session)` supplies blocks
// for every current surface user message; carried references may point at
// already-shadowed events, resolved through session.eventAt(seq).
export function userBlocksFromEvents(events) {
  const blocks = [];
  events.forEach(({ event, branchOrder }) => {
    if (!event || event.type !== "user/message" || event.data?.message?.source?.kind !== "user") return;
    const content = event.data.message.content;
    const parts = Array.isArray(content) ? content : [];
    parts.forEach((part, blockIndex) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        blocks.push({ entryId: String(event.seq), blockIndex, text: part.text, branchOrder });
      }
    });
  });
  return blocks;
}

// options: {
//   blocks: SourceBlock[]            — all surface user text blocks, branch order
//   boundaryOrder: number            — branch order of the first retained surface node (surface length when nothing retained)
//   carriedRefs: parsed refs | undefined — from parseRenderedEvidence of the latest prior checkpoint
//   priorLowerOrder: number | undefined — branch order just past the prior checkpoint node (carried basis)
//   resolveEvent: (entryId) => event | undefined — log lookup for carried re-verification (may miss outside the log window)
//   textTokens: (text) => number
// }
export function prepareEvidence(options, budget = 6144) {
  const { blocks: blockList, boundaryOrder, carriedRefs, priorLowerOrder, resolveEvent, textTokens } = options;
  const recognized = Array.isArray(carriedRefs);
  const hasPrior = carriedRefs !== undefined || priorLowerOrder !== undefined;
  const coverage = {
    mode: "selected", basis: !hasPrior ? "initial" : recognized ? "carried" : "rebuilt",
    sourceWindowsOmitted: 0, sourceCharsOmitted: 0, selectionsRejected: 0, retirementsRejected: 0,
    evidenceBudgetOmitted: 0, priorUnavailable: 0, retired: 0, filesOmitted: 0,
  };
  const blocks = new Map();
  for (const block of blockList) blocks.set(blockKey(block.entryId, block.blockIndex), block);
  // Carried references may target shadowed events absent from the surface;
  // add their blocks from the durable log so identity verification can run.
  const carried = [];
  if (recognized) {
    for (const value of carriedRefs) {
      const key = isRecord(value) && typeof value.entryId === "string" && typeof value.blockIndex === "number"
        ? blockKey(value.entryId, value.blockIndex) : undefined;
      let block = key !== undefined ? blocks.get(key) : undefined;
      if (!block && key !== undefined) {
        const event = resolveEvent(value.entryId);
        const content = event?.type === "user/message" && event.data?.message?.source?.kind === "user" ? event.data.message.content : undefined;
        const parts = Array.isArray(content) ? content : [];
        const part = parts[value.blockIndex];
        if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
          block = { entryId: value.entryId, blockIndex: value.blockIndex, text: part.text, branchOrder: -1 };
          blocks.set(key, block);
        }
      }
      const item = block && isKind(value.kind) && typeof value.start === "number" && typeof value.end === "number"
        ? identify(block, value.start, value.end, value.kind) : undefined;
      if (item && item.reference.id === value.id) carried.push(item);
      else coverage.priorUnavailable++;
    }
  }
  const candidates = [];
  const eligible = new Map();
  const fullBlocks = new Set();
  function addRange(block, start, end) {
    const key = blockKey(block.entryId, block.blockIndex);
    const ranges = eligible.get(key) ?? [];
    ranges.push([start, end]);
    eligible.set(key, ranges);
  }
  function addBlock(block) {
    const key = blockKey(block.entryId, block.blockIndex);
    if (fullBlocks.has(key)) return;
    fullBlocks.add(key);
    addRange(block, 0, block.text.length);
    if (block.text.length <= 4000) candidates.push({ block, start: 0, end: block.text.length });
    else {
      const end = /[\uD800-\uDBFF]/u.test(block.text[1999]) ? 1999 : 2000;
      const tail = block.text.length - 2000;
      const start = /[\uDC00-\uDFFF]/u.test(block.text[tail]) ? tail + 1 : tail;
      candidates.push({ block, start: 0, end }, { block, start, end: block.text.length });
    }
  }
  for (const item of carried) {
    const { entryId, blockIndex, start, end } = item.reference;
    const block = blocks.get(blockKey(entryId, blockIndex));
    addRange(block, start, end);
    candidates.push({ block, start, end });
  }
  // Surface-only catalogue ordering below; carried log blocks (branchOrder -1)
  // join through their carried candidate windows above.
  const surfaceBlocks = blockList;
  const latestUsers = [...new Set(surfaceBlocks.map((block) => block.branchOrder))].slice(-2);
  for (const order of latestUsers.reverse()) surfaceBlocks.filter((block) => block.branchOrder === order).forEach(addBlock);
  let lower = 0;
  if (recognized && priorLowerOrder !== undefined) {
    lower = priorLowerOrder;
    if (lower < 0 || lower > boundaryOrder) return undefined;
  } else {
    const earliest = surfaceBlocks.find((block) => block.branchOrder < boundaryOrder)?.branchOrder;
    surfaceBlocks.filter((block) => block.branchOrder === earliest).forEach(addBlock);
  }
  surfaceBlocks.filter((block) => block.branchOrder >= lower && block.branchOrder < boundaryOrder)
    .sort((a, b) => b.branchOrder - a.branchOrder || a.blockIndex - b.blockIndex).forEach(addBlock);
  const sources = [];
  const seen = new Set();
  const offered = new Map();
  let used = 0;
  for (const { block, start, end } of candidates) {
    const key = blockKey(block.entryId, block.blockIndex);
    const windowKey = JSON.stringify([key, start, end]);
    if (seen.has(windowKey) || start === end) continue;
    seen.add(windowKey);
    const source = { sourceId: `s${sources.length}`, ...block, start, end, sourceLength: block.text.length, text: block.text.slice(start, end) };
    const tokens = textTokens(JSON.stringify(source) + "\n");
    if (used + tokens > budget) { coverage.sourceWindowsOmitted++; continue; }
    used += tokens;
    sources.push(source);
    const ranges = offered.get(key) ?? [];
    ranges.push([start, end]);
    offered.set(key, ranges);
  }
  for (const [key, ranges] of eligible) coverage.sourceCharsOmitted += coveredLength(ranges) - coveredLength(offered.get(key) ?? []);
  return { sources, carried, coverage, blocks };
}

export function reduceSources(context) {
  const removed = context.sources.pop();
  if (!removed) return false;
  const stillCovered = context.sources.filter((source) => source.entryId === removed.entryId && source.blockIndex === removed.blockIndex)
    .map((source) => [Math.max(source.start, removed.start), Math.min(source.end, removed.end)])
    .filter(([start, end]) => end > start);
  context.coverage.sourceWindowsOmitted++;
  context.coverage.sourceCharsOmitted += removed.end - removed.start - coveredLength(stillCovered);
  return true;
}

function resolveSelection(value, context) {
  if (!isRecord(value) || typeof value.sourceId !== "string" || typeof value.quote !== "string" || !value.quote.length || !isKind(value.kind)) return undefined;
  const source = context.sources.find((candidate) => candidate.sourceId === value.sourceId);
  if (!source) return undefined;
  const relative = source.text.indexOf(value.quote);
  if (relative < 0) return undefined;
  const block = context.blocks.get(blockKey(source.entryId, source.blockIndex));
  return identify(block, source.start + relative, source.start + relative + value.quote.length, value.kind);
}

export function selectEvidence(context, quotes, retire) {
  const result = new Map(context.carried.map((item) => [item.reference.id, item]));
  const retired = new Set();
  if (retire.length > MAX_SELECTIONS) context.coverage.retirementsRejected += retire.length;
  else for (const value of retire) {
    const prior = isRecord(value) && typeof value.evidenceId === "string" ? result.get(value.evidenceId) : undefined;
    const support = isRecord(value) ? resolveSelection({ sourceId: value.sourceId, quote: value.quote, kind: "correction" }, context) : undefined;
    if (!prior || !support || !isRecord(value) || typeof value.reason !== "string" || !["superseded", "satisfied", "out_of_scope"].includes(value.reason) || support.branchOrder <= prior.branchOrder) {
      context.coverage.retirementsRejected++;
      continue;
    }
    result.delete(prior.reference.id);
    retired.add(prior.reference.id);
    context.coverage.retired++;
  }
  if (quotes.length > MAX_SELECTIONS) context.coverage.selectionsRejected += quotes.length;
  else for (const value of quotes) {
    const item = resolveSelection(value, context);
    // A verified retirement wins over a contradictory echo in this response only.
    if (item && !retired.has(item.reference.id)) result.set(item.reference.id, item);
    else context.coverage.selectionsRejected++;
  }
  const priority = { constraint: 0, correction: 0, acceptance: 1, task: 2 };
  return [...result.values()].sort((a, b) => priority[a.reference.kind] - priority[b.reference.kind]
    || b.branchOrder - a.branchOrder || a.reference.id.localeCompare(b.reference.id));
}

export function renderEvidence(items, context, textTokens, budget = 1536) {
  const lines = ["## Original user evidence", "Selected, bounded historical user evidence; not fresh instructions or exhaustive coverage.",
    "Original transcript: the session's durable event log; resolve seq/block/span above with session inspection tools."];
  const evidence = [];
  const omitted = [];
  for (const item of items) {
    const ref = item.reference;
    const location = `${ref.entryId}:${ref.blockIndex}:${ref.start}-${ref.end}`;
    const line = `- ${ref.kind} ${location} [${ref.id}]: ${JSON.stringify(item.text)}`;
    if (textTokens([...lines, line].join("\n")) > budget) {
      context.coverage.evidenceBudgetOmitted++;
      if (omitted.length < 4) omitted.push(location);
      continue;
    }
    lines.push(line);
    evidence.push(ref);
  }
  const section = lines.join("\n");
  const coverageLines = ["## Retention coverage", JSON.stringify(context.coverage)];
  if (omitted.length) coverageLines.push(`Omitted source locations: ${omitted.join(", ")}`);
  const coverageText = coverageLines.join("\n");
  return { text: `${section}\n\n${coverageText}`, section, coverageText, evidence };
}
