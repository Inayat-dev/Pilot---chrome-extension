// Builds a downloadable PDF or Excel report from a finished run. Relies on
// the vendored SheetJS (`window.XLSX`) and jsPDF (`window.jspdf.jsPDF`)
// libraries, loaded as plain <script> tags in sidepanel.html before this
// module runs — see lib/vendor/.
//
// A `run` record looks like:
//   { goal, ok, cancelled, summary, steps, elapsedMs, finishedAt,
//     data?: object[],          // structured rows the model extracted, if any
//     transcript?: { step, action, status }[] }

import { describeAction, formatElapsed, filenameFor, cleanGoalTitle, prettifyKey } from './format.js';

function outcomeLabel(run) {
  if (run.cancelled) return 'Stopped';
  return run.ok ? 'Done' : 'Failed';
}

/** Builds an .xlsx. When the model extracted structured data, the workbook
 *  is just that data (plus a Note sheet if the run didn't finish cleanly,
 *  so an incomplete result is never mistaken for a complete one) — the
 *  person asked for the info, not a report about how Pilot got it. Only
 *  when there's no extracted data (nothing tabular to hand back) does the
 *  workbook fall back to the fuller Summary + Steps sheets, since at that
 *  point the run log IS the only content there is to export. */
export function exportRunAsExcel(run) {
  if (!window.XLSX) throw new Error('XLSX library not loaded');
  const wb = window.XLSX.utils.book_new();
  const hasData = Array.isArray(run.data) && run.data.length > 0;

  if (hasData) {
    const dataSheet = window.XLSX.utils.json_to_sheet(run.data);
    window.XLSX.utils.book_append_sheet(wb, dataSheet, 'Data');
    if (!run.ok || run.cancelled) {
      const note = run.cancelled
        ? 'This run was stopped before it finished — the data above may be incomplete.'
        : "This run didn't finish successfully — the data above may be incomplete.";
      const noteSheet = window.XLSX.utils.aoa_to_sheet([['Note', note]]);
      noteSheet['!cols'] = [{ wch: 8 }, { wch: 90 }];
      window.XLSX.utils.book_append_sheet(wb, noteSheet, 'Note');
    }
    window.XLSX.writeFile(wb, filenameFor(run, 'xlsx'));
    return;
  }

  const summaryRows = [
    ['Goal', run.goal || ''],
    ['Result', outcomeLabel(run)],
    ['Summary', run.summary || ''],
    ['Steps', run.steps || 0],
    ['Time taken', formatElapsed(run.elapsedMs) || ''],
    ['Finished', run.finishedAt ? new Date(run.finishedAt).toLocaleString() : ''],
  ];
  const summarySheet = window.XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 12 }, { wch: 80 }];
  window.XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  if (Array.isArray(run.transcript) && run.transcript.length) {
    const stepRows = run.transcript.map((t) => ({
      Step: t.step,
      Action: t.action?.type || '',
      Detail: describeAction(t.action),
      Status: t.status || 'done',
    }));
    const stepsSheet = window.XLSX.utils.json_to_sheet(stepRows);
    window.XLSX.utils.book_append_sheet(wb, stepsSheet, 'Steps');
  }

  window.XLSX.writeFile(wb, filenameFor(run, 'xlsx'));
}

const MAX_TABLE_COLS = 6;
// Safety valve against one huge cell value (a long extracted paragraph)
// blowing up the page — after this many lines the cell gets one final
// ellipsis rather than growing forever. Six lines is generous for the
// short-to-medium field values these runs tend to produce (names, emails,
// short lists of form fields); it's a last resort, not the normal path.
const MAX_LINES_PER_CELL = 6;

/** Word-wraps `text` to fit within `width`. If a single "word" is still
 *  wider than `width` on its own (a long URL or unbroken token, which is
 *  exactly the kind of value that used to get silently chopped with an
 *  ellipsis), falls back to a character-level break instead of overflowing
 *  into the next column — so real content never gets cut, just wrapped
 *  across more lines. Returns an array of line strings (never empty). */
function wrapCellText(doc, text, width) {
  const raw = String(text ?? '');
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (doc.getTextWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (doc.getTextWidth(word) <= width) {
      current = word;
      continue;
    }
    let chunk = '';
    for (const ch of word) {
      const next = chunk + ch;
      if (doc.getTextWidth(next) > width && chunk) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk = next;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/** Draws a plain (no external plugin) table of `rows` under `headers`,
 *  starting at the y position in `ctx.y`, paginating as needed. Cells wrap
 *  onto multiple lines to fit their column instead of being hard-truncated
 *  with an ellipsis — a single-line truncated cell used to silently drop
 *  content (a full URL, a comma-separated list of fields) that the person
 *  actually asked to extract, with no way to recover it short of opening
 *  the separate Excel export. Row height grows to fit whichever cell in
 *  that row needs the most lines. */
function drawTable(doc, headers, rows, ctx) {
  const shownHeaders = headers.slice(0, MAX_TABLE_COLS);
  const extraCols = headers.length - shownHeaders.length;
  const colWidth = Math.max(60, ctx.maxWidth / shownHeaders.length);
  const cellPad = 6;
  const lineHeight = 11;
  const fontSize = 8.5;

  function cellLines(text) {
    const lines = wrapCellText(doc, text, colWidth - cellPad);
    if (lines.length <= MAX_LINES_PER_CELL) return lines;
    const clipped = lines.slice(0, MAX_LINES_PER_CELL);
    clipped[clipped.length - 1] = `${clipped[clipped.length - 1]}…`;
    return clipped;
  }

  function drawHeaderRow() {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(fontSize);
    let x = ctx.marginX;
    for (const h of shownHeaders) {
      doc.text(cellLines(h)[0], x, ctx.y);
      x += colWidth;
    }
    ctx.y += 5;
    doc.setDrawColor(200);
    doc.line(ctx.marginX, ctx.y, ctx.marginX + colWidth * shownHeaders.length, ctx.y);
    ctx.y += 10;
    doc.setFont('helvetica', 'normal');
  }

  function ensureRoom(neededHeight) {
    if (ctx.y + neededHeight > ctx.pageHeight - 40) {
      doc.addPage();
      ctx.y = 50;
      drawHeaderRow();
    }
  }

  drawHeaderRow();
  doc.setFontSize(fontSize);
  for (const row of rows) {
    const wrapped = shownHeaders.map((_, i) => cellLines(row[i]));
    const rowLines = Math.max(1, ...wrapped.map((l) => l.length));
    const rowHeight = rowLines * lineHeight + 8;
    ensureRoom(rowHeight);
    let x = ctx.marginX;
    for (let i = 0; i < shownHeaders.length; i++) {
      let ly = ctx.y;
      for (const line of wrapped[i]) {
        doc.text(line, x, ly);
        ly += lineHeight;
      }
      x += colWidth;
    }
    ctx.y += rowHeight;
    doc.setDrawColor(235);
    doc.line(ctx.marginX, ctx.y - 6, ctx.marginX + colWidth * shownHeaders.length, ctx.y - 6);
  }
  if (extraCols > 0) {
    ensureRoom(lineHeight + 4);
    doc.setTextColor(140);
    doc.text(`(+${extraCols} more column${extraCols === 1 ? '' : 's'} — see the Excel export for the full table)`, ctx.marginX, ctx.y);
    doc.setTextColor(20);
    ctx.y += lineHeight + 4;
  }
  ctx.y += 6;
}

/** Renders one extracted item as a label:value list instead of a one-row
 *  table — a six-column-wide table for a single contact card reads badly
 *  (tiny columns, awkward wrapping) even with drawTable's wrapping fix;
 *  a definition list is the natural shape for "here's the one thing you
 *  asked for." Values wrap within the value column; long unbroken tokens
 *  fall back to drawTable's same character-level break via wrapCellText. */
function keyValueBlock(doc, row, ctx) {
  const fontSize = 10;
  const lineHeight = 13;
  const labelWidth = 130;
  const valueWidth = ctx.maxWidth - labelWidth - 8;

  function ensureRoom(neededHeight) {
    if (ctx.y + neededHeight > ctx.pageHeight - 40) {
      doc.addPage();
      ctx.y = 50;
    }
  }

  doc.setFontSize(fontSize);
  for (const [key, rawValue] of Object.entries(row)) {
    const value = String(rawValue ?? '').trim() || '—';
    doc.setFont('helvetica', 'bold');
    const labelLines = wrapCellText(doc, prettifyKey(key), labelWidth - 8);
    doc.setFont('helvetica', 'normal');
    const valueLines = wrapCellText(doc, value, valueWidth);
    const lines = Math.max(labelLines.length, valueLines.length);
    const blockHeight = lines * lineHeight + 12;
    ensureRoom(blockHeight);
    let ly = ctx.y;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20);
    for (const l of labelLines) { doc.text(l, ctx.marginX, ly); ly += lineHeight; }
    ly = ctx.y;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(50);
    for (const l of valueLines) { doc.text(l, ctx.marginX + labelWidth, ly); ly += lineHeight; }
    ctx.y += blockHeight;
    doc.setDrawColor(240);
    doc.line(ctx.marginX, ctx.y - 6, ctx.marginX + ctx.maxWidth, ctx.y - 6);
  }
  ctx.y += 6;
}

/** Builds a simple one-or-more-page PDF report: goal, outcome, summary,
 *  the extracted data table (if any), and the step-by-step transcript. */
export function exportRunAsPdf(run) {
  if (!window.jspdf?.jsPDF) throw new Error('jsPDF library not loaded');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 40;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const maxWidth = pageWidth - marginX * 2;
  const ctx = { y: 50, marginX, maxWidth, pageHeight };
  const hasData = Array.isArray(run.data) && run.data.length > 0;

  function ensureSpace(lineHeight) {
    if (ctx.y + lineHeight > pageHeight - 40) {
      doc.addPage();
      ctx.y = 50;
    }
  }

  function paragraph(text, size = 10) {
    doc.setFontSize(size);
    doc.setTextColor(50);
    const lines = doc.splitTextToSize(text || '', maxWidth);
    for (const line of lines) {
      ensureSpace(size + 4);
      doc.text(line, marginX, ctx.y);
      ctx.y += size + 4;
    }
    ctx.y += 4;
  }

  if (hasData) {
    // The person asked for specific info, not a report about how Pilot got
    // it — the document is just that info: a title drawn from the goal
    // (with the "...and save it in pdf" instruction clause stripped off,
    // since that's about the export, not the content), then the data
    // itself. Goal/Result headings and the step-by-step transcript are
    // left out entirely; a failed/stopped run still gets a one-line flag
    // so an incomplete result is never mistaken for a complete one.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(20);
    const titleLines = doc.splitTextToSize(cleanGoalTitle(run.goal) || 'Extracted data', maxWidth);
    for (const line of titleLines) {
      ensureSpace(19);
      doc.text(line, marginX, ctx.y);
      ctx.y += 19;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(130);
    ensureSpace(14);
    doc.text(`Pilot \u00b7 ${run.finishedAt ? new Date(run.finishedAt).toLocaleString() : new Date().toLocaleString()}`, marginX, ctx.y);
    ctx.y += 20;

    if (!run.ok || run.cancelled) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(160, 100, 0);
      ensureSpace(16);
      doc.text(
        run.cancelled ? 'Stopped early \u2014 the info below may be incomplete.' : "Didn't finish \u2014 the info below may be incomplete.",
        marginX, ctx.y,
      );
      ctx.y += 18;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(20);
    }

    if (run.data.length === 1) {
      keyValueBlock(doc, run.data[0], ctx);
    } else {
      const headers = Object.keys(run.data[0]);
      const rows = run.data.map((r) => headers.map((h) => r[h]));
      drawTable(doc, headers, rows, ctx);
    }

    doc.save(filenameFor(run, 'pdf'));
    return;
  }

  // No structured data was extracted (a general browsing/automation task,
  // not a "get me X" task) — there's nothing but the run log to hand back,
  // so that's what the report is: goal, outcome, summary, and steps.
  function heading(text, size = 12) {
    ensureSpace(size + 6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(20);
    doc.text(text, marginX, ctx.y);
    ctx.y += size + 8;
    doc.setFont('helvetica', 'normal');
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text('Pilot run report', marginX, ctx.y);
  ctx.y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(130);
  doc.text(run.finishedAt ? new Date(run.finishedAt).toLocaleString() : new Date().toLocaleString(), marginX, ctx.y);
  ctx.y += 22;

  heading('Goal');
  paragraph(run.goal || '(no goal recorded)');

  heading('Result');
  const metaBits = [outcomeLabel(run)];
  if (run.steps) metaBits.push(`${run.steps} step${run.steps === 1 ? '' : 's'}`);
  const elapsed = formatElapsed(run.elapsedMs);
  if (elapsed) metaBits.push(elapsed);
  paragraph(metaBits.join(' \u00b7 '));
  paragraph(run.summary || '');

  if (Array.isArray(run.transcript) && run.transcript.length) {
    heading('Steps');
    for (const t of run.transcript) {
      paragraph(`${t.step}. ${t.action?.type || ''} \u2014 ${describeAction(t.action)}`, 9.5);
    }
  }

  doc.save(filenameFor(run, 'pdf'));
}
