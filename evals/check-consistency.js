#!/usr/bin/env node
// Consistency check for the lead scoring step.
//
// Runs the same 12 test leads through the AI step several times and checks how
// stable the result is. Only the AI part (need fit, spam, job seeker) can change
// between runs. Budget, timeline and company size are scored by code.
//
// Usage:
//   node evals/check-consistency.js <runs-folder> [--out <folder>]
//
// <runs-folder> holds one file per run, read in name order:
//   - .json: the output of the "Combine Score" node, either as copied from
//            n8n's JSON view ([{...}, ...]) or as items ([{ json: {...} }, ...])
//   - .csv:  columns lead, need_fit, is_spam, is_job_seeker, lead_score, lead_category
//            (lead is optional; rows are then read in order)
//
// --out writes three files:
//   consistency-results.csv     one row per run and lead, without emails or raw input
//   consistency-summary.md      the measures as a Markdown table
//   consistency-for-sheets.csv  one row per lead with every run's score, for a spreadsheet
//
// No dependencies. Node 18 or newer.

'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const EXPECTED_FILE = path.join(HERE, 'expected-results.csv');

// Same rules as the "Prepare Lead" and "Combine Score" nodes in the workflow.
const BUDGET = { '$25,000+': 35, '$10,000-$25,000': 25, '$5,000-$10,000': 15, 'Not sure yet': 10, 'Under $5,000': 5 };
const TIMELINE = { 'Within 1 month': 25, '1-3 months': 20, '3-6 months': 10, 'Just exploring': 3 };
const SIZE = { 'Just me': 3, '2-10': 8, '11-50': 15, '51-200': 15, '201+': 10 };
const norm = (s) => String(s).replace(/[–—]/g, '-');

function scoreFromRules(base, needFit, isSpam, isJobSeeker) {
  const fit = [0, 12, 25].includes(Number(needFit)) ? Number(needFit) : 0;
  let score = base + fit;
  if (isSpam) score = 0;
  else if (isJobSeeker) score = Math.min(score, 10);
  return score;
}
const categoryOf = (score) => (score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold');

// ---------- CSV helpers ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, j) => [h.trim(), (r[j] ?? '').trim()])));
}

const csvCell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';

const toBool = (v) => v === true || String(v).trim().toLowerCase() === 'true';

// ---------- Load expected results ----------

function loadExpected() {
  const rows = parseCsv(fs.readFileSync(EXPECTED_FILE, 'utf8'));
  return rows.map((r) => {
    const e = {
      lead: Number(r.lead),
      name: r.name,
      company: r.company,
      base: Number(r.score_budget) + Number(r.score_timeline) + Number(r.score_size),
      score_budget: Number(r.score_budget),
      score_timeline: Number(r.score_timeline),
      score_size: Number(r.score_size),
      need_fit: Number(r.expected_need_fit),
      is_spam: toBool(r.expected_is_spam),
      is_job_seeker: toBool(r.expected_is_job_seeker),
      score: Number(r.expected_score),
      category: r.expected_category,
    };
    // The table must agree with the scoring rules, or the test itself is wrong.
    const checks = [
      [BUDGET[norm(r.budget)], e.score_budget, 'budget points'],
      [TIMELINE[norm(r.timeline)], e.score_timeline, 'timeline points'],
      [SIZE[norm(r.company_size)], e.score_size, 'company size points'],
      [scoreFromRules(e.base, e.need_fit, e.is_spam, e.is_job_seeker), e.score, 'expected score'],
      [categoryOf(e.score), e.category, 'expected category'],
    ];
    for (const [fromRules, inTable, label] of checks) {
      if (fromRules !== inTable) {
        throw new Error(`expected-results.csv, lead ${e.lead}: ${label} is ${inTable}, but the scoring rules give ${fromRules}`);
      }
    }
    return e;
  });
}

// ---------- Load runs ----------

function loadRun(file) {
  const text = fs.readFileSync(file, 'utf8');
  let items;
  if (file.toLowerCase().endsWith('.csv')) {
    items = parseCsv(text);
  } else {
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = data.items || data.data || [];
    items = data.map((x) => (x && typeof x.json === 'object' ? x.json : x));
  }
  return items.map((x, i) => ({
    lead: x.lead !== undefined && x.lead !== '' ? Number(x.lead) : i + 1,
    name: x.name,
    ai_failed: toBool(x.ai_failed),
    need_fit: x.need_fit === undefined || x.need_fit === '' ? null : Number(x.need_fit),
    is_spam: toBool(x.is_spam),
    is_job_seeker: toBool(x.is_job_seeker),
    lead_score: x.lead_score === undefined || x.lead_score === '' ? null : Number(x.lead_score),
    lead_category: x.lead_category || '',
    lead_reason: x.lead_reason || '',
    score_budget: x.score_budget,
    score_timeline: x.score_timeline,
    score_size: x.score_size,
  }));
}

// ---------- Main ----------

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
  const runsDir = positional[0];
  if (!runsDir) {
    console.error('Usage: node evals/check-consistency.js <runs-folder> [--out <folder>]');
    process.exit(2);
  }

  const expected = loadExpected();
  const files = fs.readdirSync(runsDir)
    .filter((f) => /\.(json|csv)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (files.length === 0) {
    console.error(`No .json or .csv files in ${runsDir}`);
    process.exit(2);
  }

  const problems = [];
  const runs = files.map((f, r) => {
    const items = loadRun(path.join(runsDir, f));
    if (items.length !== expected.length) {
      problems.push(`${f}: ${items.length} leads, expected ${expected.length}`);
    }
    for (const it of items) {
      const e = expected.find((x) => x.lead === it.lead);
      if (!e) { problems.push(`${f}: unknown lead ${it.lead}`); continue; }
      if (it.name !== undefined && it.name !== e.name) {
        problems.push(`${f}, lead ${it.lead}: name is "${it.name}", expected "${e.name}" (are the rows in the original order?)`);
      }
      for (const k of ['score_budget', 'score_timeline', 'score_size']) {
        if (it[k] !== undefined && it[k] !== '' && Number(it[k]) !== e[k]) {
          problems.push(`${f}, lead ${it.lead}: ${k} is ${it[k]}, expected ${e[k]}`);
        }
      }
      if (it.ai_failed) problems.push(`${f}, lead ${it.lead}: the AI call failed in this run`);
      else if (it.lead_score !== null && it.lead_score !== scoreFromRules(e.base, it.need_fit, it.is_spam, it.is_job_seeker)) {
        problems.push(`${f}, lead ${it.lead}: score ${it.lead_score} does not follow the scoring rules for need_fit ${it.need_fit}`);
      }
    }
    return { file: f, run: r + 1, items };
  });

  const n = runs.length;
  const total = n * expected.length;
  let catOk = 0, fitOk = 0, flagsOk = 0, scoreOk = 0;
  const perLead = expected.map((e) => {
    const results = runs.map((run) => run.items.find((x) => x.lead === e.lead) || null);
    for (const x of results) {
      if (!x || x.ai_failed) continue;
      if (x.lead_category === e.category) catOk++;
      if (x.need_fit === e.need_fit) fitOk++;
      if (x.is_spam === e.is_spam && x.is_job_seeker === e.is_job_seeker) flagsOk++;
      if (x.lead_score === e.score) scoreOk++;
    }
    const scores = results.map((x) => (x && !x.ai_failed ? x.lead_score : null));
    const valid = scores.filter((s) => s !== null);
    const cats = results.map((x) => (x && !x.ai_failed ? x.lead_category : ''));
    return {
      e,
      results,
      scores,
      cats,
      identical: valid.length === n && valid.every((s) => s === valid[0]),
      spread: valid.length ? Math.max(...valid) - Math.min(...valid) : null,
      categoryChanged: new Set(cats.filter(Boolean)).size > 1,
    };
  });

  const identical = perLead.filter((p) => p.identical).length;
  const maxSpread = Math.max(...perLead.map((p) => p.spread ?? 0));
  const spreadLeads = perLead.filter((p) => p.spread === maxSpread && maxSpread > 0).map((p) => p.e.lead);
  const changed = perLead.filter((p) => p.categoryChanged).map((p) => p.e.lead);

  const measures = [
    ['Category as expected', `${catOk} of ${total}`],
    ['Need fit as expected', `${fitOk} of ${total}`],
    ['Spam and job seeker flags as expected', `${flagsOk} of ${total}`],
    ['Score exactly as expected', `${scoreOk} of ${total}`],
    ['Leads with the same score in every run', `${identical} of ${expected.length}`],
    ['Largest score difference for one lead', maxSpread === 0 ? '0 points' : `${maxSpread} points (lead ${spreadLeads.join(', ')})`],
    ['Leads that changed category between runs', changed.length ? changed.join(', ') : 'none'],
  ];

  // ---------- Console report ----------
  console.log(`Consistency check: ${n} runs x ${expected.length} leads (${files.join(', ')})\n`);
  for (const [k, v] of measures) console.log(`  ${k.padEnd(42)} ${v}`);
  console.log('\n  lead  name             expected        ' + runs.map((r) => `run ${r.run}`.padEnd(10)).join(''));
  for (const p of perLead) {
    const exp = `${p.e.score} ${p.e.category}`.padEnd(16);
    const cells = p.results.map((x) => (!x ? 'missing' : x.ai_failed ? 'AI failed' : `${x.lead_score} ${x.lead_category}`).padEnd(10)).join('');
    const mark = p.identical ? '' : '  <- varies';
    console.log(`  ${String(p.e.lead).padEnd(6)}${p.e.name.padEnd(17)}${exp}${cells}${mark}`);
  }
  if (problems.length) {
    console.log('\nProblems found:');
    for (const m of problems) console.log('  - ' + m);
  }

  // ---------- Files ----------
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });

    const resultRows = [];
    for (const run of runs) {
      for (const x of run.items) {
        const e = expected.find((y) => y.lead === x.lead) || {};
        resultRows.push({
          run: run.run, lead: x.lead, name: e.name, company: e.company,
          need_fit: x.need_fit, is_spam: x.is_spam, is_job_seeker: x.is_job_seeker,
          lead_score: x.lead_score, lead_category: x.lead_category, ai_failed: x.ai_failed,
          lead_reason: x.lead_reason,
        });
      }
    }
    fs.writeFileSync(path.join(outDir, 'consistency-results.csv'), toCsv(
      ['run', 'lead', 'name', 'company', 'need_fit', 'is_spam', 'is_job_seeker', 'lead_score', 'lead_category', 'ai_failed', 'lead_reason'],
      resultRows,
    ));

    const sheetHeader = ['lead', 'name', 'expected_score', 'expected_category',
      ...runs.map((r) => `run_${r.run}_score`), ...runs.map((r) => `run_${r.run}_category`), 'score_difference', 'same_score_every_run'];
    const sheetRows = perLead.map((p) => {
      const row = { lead: p.e.lead, name: p.e.name, expected_score: p.e.score, expected_category: p.e.category,
        score_difference: p.spread, same_score_every_run: p.identical ? 'yes' : 'no' };
      runs.forEach((r, i) => { row[`run_${r.run}_score`] = p.scores[i] ?? ''; row[`run_${r.run}_category`] = p.cats[i]; });
      return row;
    });
    fs.writeFileSync(path.join(outDir, 'consistency-for-sheets.csv'), toCsv(sheetHeader, sheetRows));

    const md = ['| Measure | Result |', '|---|---|', ...measures.map(([k, v]) => `| ${k} | ${v} |`)].join('\n') + '\n';
    fs.writeFileSync(path.join(outDir, 'consistency-summary.md'), md);
    console.log(`\nWrote consistency-results.csv, consistency-for-sheets.csv and consistency-summary.md to ${outDir}`);
  }

  process.exit(problems.length ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('Error: ' + err.message);
  process.exit(2);
}
