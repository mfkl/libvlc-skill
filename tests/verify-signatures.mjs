/**
 * Verify libvlc-skill.md function signatures against actual VLC C headers.
 *
 * Fetches public headers from https://github.com/videolan/vlc for both
 * the 3.0.x branch and master (4.x) branch, extracts LIBVLC_API function
 * declarations, and cross-references them with what the skill document claims.
 *
 * Usage:  node tests/verify-signatures.mjs
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(__dirname, "..", "skills", "libvlc", "libvlc-skill.md");

const GITHUB_RAW = "https://raw.githubusercontent.com/videolan/vlc";

const HEADER_FILES = [
  "include/vlc/libvlc.h",
  "include/vlc/libvlc_media.h",
  "include/vlc/libvlc_media_player.h",
  "include/vlc/libvlc_media_list.h",
  "include/vlc/libvlc_media_list_player.h",
  "include/vlc/libvlc_media_discoverer.h",
  "include/vlc/libvlc_renderer_discoverer.h",
  "include/vlc/libvlc_dialog.h",
  "include/vlc/libvlc_vlm.h",
  "include/vlc/libvlc_media_track.h",
  "include/vlc/libvlc_picture.h",
  "include/vlc/libvlc_video.h",
];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function fetchHeaders(branch) {
  const results = {};
  const fetches = HEADER_FILES.map(async (file) => {
    const text = await fetchText(`${GITHUB_RAW}/${branch}/${file}`);
    if (text) results[file] = text;
  });
  await Promise.all(fetches);
  return results;
}

// ---------------------------------------------------------------------------
// Parse LIBVLC_API declarations from C header text
// ---------------------------------------------------------------------------

function parseHeaderFunctions(headerText) {
  const functions = new Map();
  const normalized = headerText.replace(/\\\n/g, " ");
  const lines = normalized.split("\n");
  let buffer = "";
  let collecting = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      if (collecting && !trimmed.includes("*/")) continue;
    }

    if (!collecting) {
      if (/\bLIBVLC_API\b/.test(trimmed) && !trimmed.startsWith("*") && !trimmed.startsWith("//")) {
        buffer = trimmed;
        if (trimmed.includes(";")) {
          processDeclaration(buffer, functions);
          buffer = "";
        } else {
          collecting = true;
        }
      }
    } else {
      buffer += " " + trimmed;
      if (trimmed.includes(";")) {
        collecting = false;
        processDeclaration(buffer, functions);
        buffer = "";
      }
    }
  }

  return functions;
}

function countTopLevelCommas(str) {
  let depth = 0;  // tracks (), {}, and nested structures
  let commas = 0;
  let inString = false;
  let stringChar = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === stringChar && str[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
    else if (ch === "," && depth === 0) commas++;
  }
  return commas;
}

function processDeclaration(decl, functions) {
  const clean = decl.replace(/\s+/g, " ").trim();

  // Extract function name, then find balanced params up to the matching ")"
  const nameMatch = clean.match(/\b(libvlc_\w+)\s*\(/);
  if (!nameMatch) return;

  const name = nameMatch[1];
  const start = nameMatch.index + nameMatch[0].length;

  // Walk forward from start, tracking paren depth to find the matching ")"
  let depth = 1;
  let end = start;
  for (let i = start; i < clean.length && depth > 0; i++) {
    if (clean[i] === "(") depth++;
    else if (clean[i] === ")") depth--;
    if (depth === 0) { end = i; break; }
  }

  const paramsStr = clean.substring(start, end).trim();
  const paramCount = (paramsStr === "void" || paramsStr === "")
    ? 0
    : countTopLevelCommas(paramsStr) + 1;

  functions.set(name, { paramCount, signature: clean });
}

// ---------------------------------------------------------------------------
// Parse skill markdown for function references
// ---------------------------------------------------------------------------

function extractFunctionRefs(line) {
  const refs = [];
  const pattern = /\b(libvlc_\w+)\s*\(/g;
  let m;
  while ((m = pattern.exec(line)) !== null) {
    const name = m[1];
    const start = m.index + m[0].length;
    // Walk forward tracking paren depth
    let depth = 1;
    let end = start;
    for (let i = start; i < line.length && depth > 0; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") depth--;
      if (depth === 0) { end = i; break; }
    }
    const paramsStr = line.substring(start, end).trim();
    refs.push({ name, paramsStr });
  }
  return refs;
}

function parseSkillFunctions(skillText) {
  const functions = new Map();
  const lines = skillText.split("\n");

  // Track version context at multiple levels
  let sectionVersion = "both";    // from markdown headings
  let blockVersion = null;        // from bold markers like **`[4.x]`**
  let codeBlockVersion = null;    // from // [4.x] comments inside code blocks
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code block boundaries
    if (/^```/.test(line.trim())) {
      if (inCodeBlock) {
        // Leaving code block — reset code block version
        inCodeBlock = false;
        codeBlockVersion = null;
      } else {
        inCodeBlock = true;
        codeBlockVersion = null;
      }
      continue;
    }

    // Update section-level version from markdown headings
    if (!inCodeBlock && /^#{1,4}\s/.test(line)) {
      blockVersion = null; // reset block version on new heading
      if (/\[3\.x\]/.test(line) && !/\[4\.x/.test(line)) {
        sectionVersion = "3.x";
      } else if (/\[4\.x\]/.test(line)) {
        sectionVersion = "4.x";
      } else {
        sectionVersion = "both";
      }
    }

    // Detect bold version markers like **`[4.x]`** at start of a paragraph
    if (!inCodeBlock && /^\*\*`?\[4\.x\]`?\*\*/.test(line.trim())) {
      blockVersion = "4.x";
    } else if (!inCodeBlock && /^\*\*`?\[3\.x\]`?\*\*/.test(line.trim())) {
      blockVersion = "3.x";
    }

    // Inside code blocks, detect // [4.x] or // [3.x] comments as context
    if (inCodeBlock) {
      if (/\/\/\s*\[4\.x\]/.test(line)) codeBlockVersion = "4.x";
      else if (/\/\/\s*\[3\.x\]/.test(line)) codeBlockVersion = "3.x";
    }

    // Use balanced paren extraction instead of simple [^)]* regex
    const refs = extractFunctionRefs(line);
    for (const ref of refs) {
      const name = ref.name;
      const paramsStr = ref.paramsStr;

      const paramCount = (paramsStr === "" || paramsStr === "void")
        ? 0
        : countTopLevelCommas(paramsStr) + 1;

      // Determine version: line-level markers > code block context > block context > section
      let version;
      if (/\[3\.x\]/.test(line) && !/\[4\.x/.test(line)) {
        version = "3.x";
      } else if (/\[4\.x\]/.test(line) || /\[4\.x change\]/.test(line)) {
        version = "4.x";
      } else if (inCodeBlock && codeBlockVersion) {
        version = codeBlockVersion;
      } else if (blockVersion) {
        version = blockVersion;
      } else {
        version = sectionVersion;
      }

      const isSignature = paramCount > 0;

      if (!functions.has(name)) {
        functions.set(name, {
          signatureParamCounts: new Map(),
          lines: [],
          versions: new Set(),
        });
      }
      const entry = functions.get(name);
      entry.lines.push(i + 1);
      entry.versions.add(version);

      if (isSignature) {
        const key = `${version}:${paramCount}`;
        if (!entry.signatureParamCounts.has(key)) {
          entry.signatureParamCounts.set(key, { version, paramCount, line: i + 1 });
        }
      }
    }
  }

  return functions;
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== libvlc-skill Signature Verification ===\n");
  console.log("Fetching headers from github.com/videolan/vlc ...\n");

  const [headers3x, headers4x] = await Promise.all([
    fetchHeaders("3.0.x"),
    fetchHeaders("master"),
  ]);

  const funcs3x = new Map();
  for (const [file, text] of Object.entries(headers3x)) {
    for (const [name, info] of parseHeaderFunctions(text)) {
      funcs3x.set(name, { ...info, file });
    }
  }

  const funcs4x = new Map();
  for (const [file, text] of Object.entries(headers4x)) {
    for (const [name, info] of parseHeaderFunctions(text)) {
      funcs4x.set(name, { ...info, file });
    }
  }

  console.log(`  3.0.x branch: ${funcs3x.size} LIBVLC_API functions found`);
  console.log(`  master branch: ${funcs4x.size} LIBVLC_API functions found\n`);

  const skillText = await readFile(SKILL_PATH, "utf-8");
  const skillFuncs = parseSkillFunctions(skillText);
  console.log(`  Skill document: ${skillFuncs.size} unique function references found\n`);

  const errors = [];
  const warnings = [];
  const info = [];
  const allHeaderFuncs = new Set([...funcs3x.keys(), ...funcs4x.keys()]);

  for (const [name, entry] of skillFuncs) {
    const in3x = funcs3x.has(name);
    const in4x = funcs4x.has(name);

    // Check 1: Function exists in at least one version
    if (!in3x && !in4x) {
      info.push(
        `${name} (line ${entry.lines[0]}) - not found as LIBVLC_API ` +
        `(may be inline/macro/unfetched header)`
      );
      continue;
    }

    // Check 2: Version marker accuracy
    // Only flag if the function is EXCLUSIVELY marked with the wrong version
    // (i.e., it appears in the skill only with [3.x] but only exists in 4.x, or vice versa)
    if (!in3x && in4x && entry.versions.has("3.x") && !entry.versions.has("4.x") && !entry.versions.has("both")) {
      errors.push(`${name} - marked [3.x] only in skill but only exists in master (4.x) headers`);
    }
    if (in3x && !in4x && entry.versions.has("4.x") && !entry.versions.has("3.x") && !entry.versions.has("both")) {
      errors.push(`${name} - marked [4.x] only in skill but only exists in 3.0.x headers`);
    }

    // Check 3: Parameter count verification (only for actual signature references)
    for (const [, { version, paramCount, line }] of entry.signatureParamCounts) {
      let headerInfo;
      if (version === "3.x") {
        headerInfo = funcs3x.get(name);
      } else if (version === "4.x") {
        headerInfo = funcs4x.get(name);
      } else {
        // "both" - should match at least one version
        const h3 = funcs3x.get(name);
        const h4 = funcs4x.get(name);
        if (h3 && h3.paramCount === paramCount) continue;
        if (h4 && h4.paramCount === paramCount) continue;
        headerInfo = h3 || h4;
      }

      if (headerInfo && headerInfo.paramCount !== paramCount) {
        const diff = Math.abs(headerInfo.paramCount - paramCount);
        if (diff >= 2) {
          errors.push(
            `${name} (line ${line}, ${version}) - skill shows ${paramCount} params, ` +
            `header has ${headerInfo.paramCount}`
          );
        } else {
          warnings.push(
            `${name} (line ${line}, ${version}) - skill shows ${paramCount} params, ` +
            `header has ${headerInfo.paramCount}`
          );
        }
      }
    }
  }

  // Check 4: Version-only detection
  // Functions that exist in only one version but the skill never marks them as such
  const versionWarnings = [];
  for (const [name, entry] of skillFuncs) {
    const in3x = funcs3x.has(name);
    const in4x = funcs4x.has(name);

    // Only warn if the function is EXCLUSIVELY in one version and the skill
    // only uses "both" context (never mentions the correct version marker)
    if (in3x && !in4x && !entry.versions.has("3.x") && entry.versions.has("both")) {
      versionWarnings.push(
        `${name} - only in 3.x headers but never marked [3.x] (line ${entry.lines[0]})`
      );
    }
    if (!in3x && in4x && !entry.versions.has("4.x") && entry.versions.has("both")) {
      versionWarnings.push(
        `${name} - only in 4.x headers but never marked [4.x] (line ${entry.lines[0]})`
      );
    }
  }

  // Check 5: Coverage gaps
  const coverageGaps = [];
  for (const name of allHeaderFuncs) {
    if (!skillFuncs.has(name)) {
      const where = funcs3x.has(name) && funcs4x.has(name)
        ? "both"
        : funcs3x.has(name) ? "3.x only" : "4.x only";
      coverageGaps.push(`${name} (${where})`);
    }
  }

  // --- Print results ---
  const sections = [
    { title: "ERRORS (incorrect or significantly wrong)", items: errors, prefix: "  ERROR: " },
    { title: "PARAM COUNT WARNINGS (off by 1)", items: warnings, prefix: "  WARN:  " },
    { title: "VERSION MARKER WARNINGS", items: versionWarnings, prefix: "  WARN:  " },
    { title: "COVERAGE GAPS (in headers, not in skill)", items: coverageGaps, prefix: "  GAP:   " },
    { title: "INFO (referenced but not LIBVLC_API)", items: info, prefix: "  INFO:  " },
  ];

  for (const { title, items, prefix } of sections) {
    console.log("─".repeat(60));
    console.log(title + ":");
    console.log("─".repeat(60));
    if (items.length === 0) {
      console.log("  None ✓");
    } else {
      items.forEach((item) => console.log(prefix + item));
    }
    console.log();
  }

  // Summary
  console.log("═".repeat(60));
  console.log("SUMMARY");
  console.log("═".repeat(60));
  console.log(`  Errors:            ${errors.length}`);
  console.log(`  Param warnings:    ${warnings.length}`);
  console.log(`  Version warnings:  ${versionWarnings.length}`);
  console.log(`  Coverage gaps:     ${coverageGaps.length}`);
  console.log(`  Info notes:        ${info.length}`);
  console.log(`  Header functions:  ${allHeaderFuncs.size} (3.x: ${funcs3x.size}, 4.x: ${funcs4x.size})`);
  console.log(`  Skill references:  ${skillFuncs.size} unique functions`);
  const covered = [...allHeaderFuncs].filter((f) => skillFuncs.has(f)).length;
  console.log(`  Coverage:          ${covered}/${allHeaderFuncs.size} (${((covered / allHeaderFuncs.size) * 100).toFixed(1)}%)`);

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
