#!/usr/bin/env node
/**
 * embed-engine.mjs — splice the Deluge posting engine into the app .ds.
 *
 * Inputs (defaults match the repo layout):
 *   --master   scripts/zoho/roligt-plant-ops.ds      the 30-form app definition
 *   --engine   docs/zoho-posting-engine.deluge       the engine (functions only)
 *   --app-name "Roligt Plant Ops v2"                 application name in the output
 *   --out      scripts/zoho/roligt-plant-ops-engine.ds
 *
 * Output: a copy of the master with two blocks inserted before share_settings,
 * in the exact shapes Creator itself serializes (dialect harvested from a real
 * export, 21-Sep-2026):
 *
 *   functions { Deluge { <engine functions verbatim> } }
 *   workflow  { form { <one entry per form workflow> } }
 *
 * The workflow block is the two-stage wiring: on validate runs the *Check
 * function (pure checks, cancel submit on error), on success runs the posting
 * half — the record exists by then, so input.ID resolves the QC_Records.Batch
 * lookup. on success cannot cancel a submit; a posting failure there leaves
 * the record un-posted and tells the operator.
 *
 * Re-run any time the engine changes; the output is always a fresh import
 * target (imports create a NEW app — reseed after importing).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const masterPath = opt('master', resolve(root, 'scripts/zoho/roligt-plant-ops.ds'))
const enginePath = opt('engine', resolve(root, 'docs/zoho-posting-engine.deluge'))
const appName = opt('app-name', 'Roligt Plant Ops v2')
const outPath = opt('out', resolve(root, 'scripts/zoho/roligt-plant-ops-engine.ds'))
const noWorkflow = args.includes('--no-workflow')

const master = readFileSync(masterPath, 'utf8')
const engineAll = readFileSync(enginePath, 'utf8')

// ── engine body: everything before the FORM WIRING banner (the wiring ships as
// real workflow entries; keeping it also as comments would duplicate drift).
const wiringIdx = engineAll.indexOf('// -- FORM WIRING')
if (wiringIdx < 0) throw new Error('engine: FORM WIRING banner not found')
const engine = engineAll.slice(0, wiringIdx).trimEnd()

// ── lint: constructs Deluge does not accept, caught here rather than at import.
const codeLines = engine.split('\n').map((l, i) => [i + 1, l])
for (const [no, line] of codeLines) {
  const code = line.replace(/\/\/.*$/, '')
  if (/\+=|-=|\*\=|\/=/.test(code)) throw new Error(`engine line ${no}: compound assignment is not Deluge — ${line.trim()}`)
  if (/\+\+|--/.test(code.replace(/"[^"]*"/g, ''))) throw new Error(`engine line ${no}: ++/-- is not Deluge — ${line.trim()}`)
  if (/\.repeat\(/.test(code)) throw new Error(`engine line ${no}: String.repeat() does not exist in Deluge — ${line.trim()}`)
  if (/^\s*for\s+\w+\s*=[^)]*;/.test(code)) throw new Error(`engine line ${no}: C-style numeric for is not Deluge — use "for each x in <var>" — ${line.trim()}`)
  if (/^\s*for each\s+\w+\s+in\s*\{/.test(code)) throw new Error(`engine line ${no}: for each over an INLINE literal is rejected — assign the list to a variable first, then iterate the variable — ${line.trim()}`)
  if (/\{\s*\d/.test(code)) throw new Error(`engine line ${no}: bare number in a list literal — official Deluge examples quote every element: {"0", "1"} — ${line.trim()}`)
  if (/\.sort\(\s*"/.test(code)) throw new Error(`engine line ${no}: sort() only takes a boolean for SCALAR lists — record ordering goes in the fetch clause (sort by Field asc) — ${line.trim()}`)
  if (/\s\?\s/.test(code)) throw new Error(`engine line ${no}: ternary "? :" is REJECTED by this editor — use if/else blocks — ${line.trim()}`)
  if (/\s:\s/.test(code)) throw new Error(`engine line ${no}: space-colon-space in code — old insert/update syntax — the new dialect uses [ Field = value ] — ${line.trim()}`)
  if (/\{\s*"\w+"\s*:/.test(code)) throw new Error(`engine line ${no}: map literal — build with m = Map(); m.put("k", v) — ${line.trim()}`)
  if (/^\s*update\s+\w+\s*\[/.test(code)) throw new Error(`engine line ${no}: classic update Form[criteria] set — new dialect: fetchedRecord.Field = value — ${line.trim()}`)
  if (/\.replace\(/.test(code) && !/\.replaceAll\(/.test(code)) throw new Error(`engine line ${no}: bare replace() does not exist in this dialect — use replaceAll(search, replace, false) for literals — ${line.trim()}`)
  if (/replaceAll\(/.test(code) && !/, false\)/.test(code)) throw new Error(`engine line ${no}: replaceAll without the literal-mode third argument false — default is regex and rejects brace tokens — ${line.trim()}`)
}
if (/[^\x00-\x7F]/.test(engine)) {
  const bad = engine.split('\n').findIndex((l) => /[^\x00-\x7F]/.test(l))
  throw new Error(`engine line ${bad + 1}: non-ASCII character — the whole engine must stay ASCII through .ds (comments included)`)
}
const fnCount = (engine.match(/^(string|void|map|decimal|list|bool|int)\s+\w+\s*\(/gm) || []).length
const need = ['mintDocNo', 'itemRef', 'locRef', 'ledgerBalance', 'drawStock', 'appendLedger', 'audit', 'postGrnCheck', 'postGrn', 'postBatchCheck', 'postBatch']
for (const fn of need) if (!new RegExp(`\\b${fn}\\s*\\(`).test(engine)) throw new Error(`engine: function ${fn} not found`)

// ── functions block — Creator's own serialization shape.
const functionsBlock = [
  '\t functions',
  '\t {',
  '\t\t Deluge',
  '\t\t {',
  engine,
  '\t\t }',
  '\t }',
  '',
].join('\n')

// ── workflow entries — shape harvested from a real export (link as "display"):
// engine_probe as "engine probe" { type = form / form = Vendor_Types /
// record event = on add / on success { actions { custom deluge script ( … ) } } }
const entry = (link, display, form, stage, script) => [
  `\t\t${link} as "${display}"`,
  '\t\t{',
  '\t\t\ttype = form',
  `\t\t\tform = ${form}`,
  '',
  '\t\t\trecord event = on add',
  '',
  `\t\t\t${stage}`,
  '\t\t\t{',
  '\t\t\t\tactions',
  '\t\t\t\t{',
  '\t\t\t\t\tcustom deluge script',
  '\t\t\t\t\t(',
  script.trim().split('\n').map((l) => `\t\t\t\t\t\t${l.trim()}`).join('\n'),
  '\t\t\t\t\t)',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t}',
].join('\n')

const grnCheck = entry('grn_check', 'GRN check', 'GRNs', 'on validate', `
e = postGrnCheck(input.toMap());
if(e != "")
{
    alert e;
    cancel submit;
}`)
const grnPost = entry('grn_post', 'GRN post', 'GRNs', 'on success', `
r = postGrn(input.toMap());
if(r.get("error") == null)
{
    input.Doc_No = r.get("grn");
    input.Status = "Posted";
    notesPrefix = "";
    if(!isNull(input.Notes))
    {
        notesPrefix = input.Notes;
    }
    input.Notes = notesPrefix + " | Lot " + r.get("lot");
}
else
{
    alert "Posting failed - this record is saved WITHOUT stock lines. Fix and resubmit: " + r.get("error");
}`)
const batchCheck = entry('batch_check', 'Batch check', 'Batches', 'on validate', `
e = postBatchCheck(input.toMap());
if(e != "")
{
    alert e;
    cancel submit;
}`)
const batchPost = entry('batch_post', 'Batch post', 'Batches', 'on success', `
r = postBatch(input.toMap(), input.ID);
if(r.get("error") == null)
{
    input.Batch_No = r.get("batch");
    input.Cost_per_Unit = r.get("costPerUnit");
    input.Status = "Awaiting QC";
}
else
{
    alert "Posting failed - this record is saved WITHOUT stock lines. Fix and resubmit: " + r.get("error");
}`)

const workflowBlock = [
  '\tworkflow',
  '\t{',
  '\tform',
  '\t{',
  grnCheck,
  grnPost,
  batchCheck,
  batchPost,
  '\t}',
  '\t}',
].join('\n')

// ── splice before share_settings (single-tab line, exactly once).
const shareLines = master.split('\n').filter((l) => /^\tshare_settings$/.test(l))
if (shareLines.length !== 1) throw new Error(`master: expected exactly one share_settings line, found ${shareLines.length}`)
const appLine = master.match(/^\s*application ".*"$/m)
if (!appLine) throw new Error('master: application name line not found')

let out = master.replace(/^\s*application ".*"$/m, ` application "${appName}"`)
const insertAt = out.split('\n').findIndex((l) => /^\tshare_settings$/.test(l))
const blocks = noWorkflow ? [functionsBlock, ''] : [functionsBlock, '', workflowBlock, '']
out = out
  .split('\n')
  .toSpliced(insertAt, 0, ...blocks)
  .join('\n')

// ── structural checks on the result.
const formsBefore = (master.match(/^\t\tform \w+$/gm) || []).length
const formsAfter = (out.match(/^\t\tform \w+$/gm) || []).length
if (formsBefore !== formsAfter || formsBefore === 0) throw new Error(`form count changed: ${formsBefore} -> ${formsAfter}`)
const braces = (out.match(/{/g) || []).length - (out.match(/}/g) || []).length
const parensOnly = out.includes('custom deluge script')
const wfEntries = (out.match(/^\t\t\w+ as "/gm) || []).length
if (out.indexOf(' functions') < 0 || parensOnly !== !noWorkflow || wfEntries !== (noWorkflow ? 0 : 4)) throw new Error('splice checks failed (functions/workflow/entries)')

writeFileSync(outPath, out)
console.log(`OK  ${outPath}`)
console.log(`    app name      : ${appName}`)
console.log(`    forms         : ${formsAfter}`)
console.log(`    engine fns    : ${fnCount} (${need.join(', ')})`)
console.log(`    brace delta   : ${braces} (0 expected inside Deluge bodies' map literals is NOT required — informational)`)
console.log(`    workflows     : ${wfEntries} (grn_check, grn_post, batch_check, batch_post)`)
console.log(`    size          : ${out.length} bytes`)
