// Reads the first sheet of an Excel (.xlsx) or CSV/text file in the browser
// and returns its rows as arrays of cell texts -- no clipboard needed.
// .xlsx is a zip of XML files: the zip is unpacked with the browser's own
// DecompressionStream, then the sheet and its shared strings are read.

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// name -> Uint8Array for the files in a zip.
async function unzip(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    files[name] = { method, data };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async (name) => {
    const f = files[name];
    if (!f) return null;
    return dec.decode(f.method === 0 ? f.data : await inflate(f.data));
  };
  return { names: Object.keys(files), read };
}

const colIndex = (ref) => {
  const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// Excel stores dates as day numbers from 1899-12-30.
const excelDate = (n) => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);

async function readXlsx(buf) {
  const zip = await unzip(buf);
  const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const shared = [];
  const sst = await zip.read('xl/sharedStrings.xml');
  if (sst) {
    for (const si of xml(sst).getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    }
  }
  // Which cell styles are dates, so an expiry date reads as a date.
  const dateStyles = new Set();
  const styles = await zip.read('xl/styles.xml');
  if (styles) {
    const doc = xml(styles);
    const custom = new Map([...doc.getElementsByTagName('numFmt')].map((f) => [f.getAttribute('numFmtId'), f.getAttribute('formatCode') || '']));
    const xfs = doc.getElementsByTagName('cellXfs')[0];
    if (xfs) {
      [...xfs.getElementsByTagName('xf')].forEach((xf, i) => {
        const id = Number(xf.getAttribute('numFmtId'));
        const code = custom.get(String(id)) || '';
        if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) dateStyles.add(i);
      });
    }
  }
  // The sheet with the most filled cells: QuickBooks puts an "Export Tips"
  // sheet first, the data is on the next one.
  const sheetNames = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetNames.length) throw new Error('No sheet found in this file.');
  let doc = null;
  let best = -1;
  for (const name of sheetNames) {
    const d = xml(await zip.read(name));
    const filled = [...d.getElementsByTagName('c')].filter((c) => (c.getElementsByTagName('v')[0]?.textContent ?? c.getElementsByTagName('t')[0]?.textContent ?? '') !== '').length;
    if (filled > best) { best = filled; doc = d; }
  }
  const rows = [];
  for (const row of doc.getElementsByTagName('row')) {
    const cells = [];
    // Some programs leave out the cell reference (r="B2"): then each cell
    // is simply the next column.
    let next = 0;
    for (const c of row.getElementsByTagName('c')) {
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let text;
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== '' && dateStyles.has(Number(c.getAttribute('s'))) && Number.isFinite(Number(v))) text = excelDate(Number(v));
      // Excel keeps 1.15 as 1.1499999999999999: round to 12 digits -> 1.15.
      else if (v !== '' && Number.isFinite(Number(v))) text = String(parseFloat(Number(v).toPrecision(12)));
      else text = v;
      const ref = c.getAttribute('r');
      const col = ref && /[A-Z]/i.test(ref) ? colIndex(ref) : next;
      cells[col] = String(text).trim();
      next = col + 1;
    }
    rows.push(Array.from(cells, (x) => x ?? ''));
  }
  return rows;
}

function readDelimited(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines.some((l) => l.includes(';')) && !lines.some((l) => l.includes(',')) ? ';' : ',';
  return lines.map((line) => {
    if (sep === '\t') return line.split('\t').map((c) => c.trim());
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

// Turns a sheet into stock rows [Item, Qty, Cost, Selling, Expiry], wherever
// those columns are. With a header row (Item / Name / Product, Qty /
// Quantity / On Hand, Cost, Price / Selling / Sales Price, Expiry) the
// columns are found by their titles; without one, columns that are empty all
// the way down are dropped, so a blank first column does not hide the names.
export function stockColumns(sheet) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const find = (row, tests, taken) => {
    for (const test of tests) {
      const i = row.findIndex((cell, k) => !taken.includes(k) && test.test(norm(cell)));
      if (i !== -1) return i;
    }
    return -1;
  };
  const isText = (v) => String(v ?? '').trim() !== '' && !Number.isFinite(Number(String(v).replace(/[$,]/g, '')));
  for (let h = 0; h < Math.min(sheet.length, 15); h += 1) {
    const row = sheet[h] || [];
    const taken = [];
    let name = find(row, [/^(item|items|item name|name|product|products|product name|product\/service)$/, /item|name|product/, /^description$/], taken);
    if (name !== -1) taken.push(name);
    const qty = find(row, [/^(qty|quantity|qty on hand|on hand|stock|quantity on hand)$/, /qty|quantity|on hand/], taken);
    if (qty !== -1) taken.push(qty);
    const cost = find(row, [/cost|purchase/], taken);
    if (cost !== -1) taken.push(cost);
    const sell = find(row, [/sell|sales price|^price$|price|rate|mrp/], taken);
    if (sell !== -1) taken.push(sell);
    const expiry = find(row, [/exp/], taken);
    if (expiry !== -1) taken.push(expiry);
    // A real header has at least one known column besides the name.
    if (qty === -1 && cost === -1 && sell === -1 && expiry === -1) continue;
    // No title over the names (QuickBooks' Inventory Valuation Summary):
    // the names are the untitled column holding the most text below.
    if (name === -1) {
      const below = sheet.slice(h + 1);
      const width = Math.max(0, ...below.map((r) => r.length));
      let most = 0;
      for (let i = 0; i < width; i += 1) {
        if (taken.includes(i)) continue;
        const n = below.filter((r) => isText(r[i])).length;
        if (n > most) { most = n; name = i; }
      }
      if (name === -1) continue;
    }
    const at = (r, i) => (i === -1 ? '' : r[i] ?? '');
    return sheet.slice(h + 1).map((r) => [at(r, name), at(r, qty), at(r, cost), at(r, sell), at(r, expiry)]);
  }
  const width = Math.max(0, ...sheet.map((r) => r.length));
  const used = [...Array(width).keys()].filter((i) => sheet.some((r) => String(r[i] ?? '').trim() !== ''));
  return sheet.map((r) => used.map((i) => r[i] ?? ''));
}

export async function readSheetFile(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x50 && head[1] === 0x4b) return readXlsx(buf); // "PK": a zip, so .xlsx
  if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files cannot be read: in Excel use Save As → Excel Workbook (.xlsx).');
  return readDelimited(new TextDecoder().decode(buf));
}
