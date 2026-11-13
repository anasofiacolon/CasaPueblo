// Minimal, dependency-free, READ-ONLY .xlsx reader.
// An .xlsx file is a ZIP of XML parts; this opens the file for reading only and
// returns each worksheet as rows of cell values. It never writes to the workbook.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** name -> Buffer for every entry in a ZIP archive (store and deflate methods). */
function unzip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('No es un archivo .xlsx válido (no se encontró el directorio ZIP).');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Directorio ZIP dañado.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`Método de compresión no soportado (${method}) en ${name}.`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()],
    )
    // Excel escapes control characters as _xHHHH_.
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Text of a string item: every <t> run, ignoring phonetic guides (<rPh>). */
function richText(xml) {
  const withoutPhonetic = xml.replace(/<rPh[\s>][\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decode(m[1]);
  return out;
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * @returns {{ name: string, values: (string|number|boolean|null)[][] }[]}
 * One entry per worksheet, in workbook order. `values[0]` is the first row
 * (normally the header); empty cells are null and row/column gaps are preserved.
 */
export function readWorkbook(path) {
  const files = unzip(readFileSync(path));
  const part = (name) => {
    const data = files.get(name);
    if (!data) throw new Error(`Falta ${name} en el libro.`);
    return data.toString('utf8');
  };

  const shared = files.has('xl/sharedStrings.xml') ? [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => richText(m[1] ?? '')) : [];

  const targets = new Map();
  for (const m of part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)) targets.set(attr(m[0], 'Id'), attr(m[0], 'Target'));

  const sheets = [];
  for (const m of part('xl/workbook.xml').matchAll(/<sheet\s[^>]*>/g)) {
    const target = targets.get(attr(m[0], 'r:id'));
    const file = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const values = [];
    for (const row of part(file).matchAll(/<row\s[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowIndex = Number(attr(row[0], 'r')) - 1;
      const cells = [];
      for (const c of (row[1] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = ` ${c[1]}`;
        const type = attr(tag, 't');
        const body = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = null;
        if (type === 'inlineStr') value = richText(body);
        else if (v === undefined) value = null;
        else if (type === 's') value = shared[Number(v)] ?? null;
        else if (type === 'b') value = v === '1';
        else if (type === 'str' || type === 'e') value = decode(v);
        else value = Number(v);
        cells[columnIndex(attr(tag, 'r'))] = value;
      }
      values[rowIndex] = Array.from(cells, (x) => x ?? null);
    }
    // Formatted-but-empty rows at the bottom of a sheet are not data.
    const filled = Array.from(values, (r) => r ?? []);
    while (filled.length && filled[filled.length - 1].every((v) => v === null || String(v).trim() === '')) filled.pop();
    sheets.push({ name: decode(attr(m[0], 'name')), values: filled });
  }
  return sheets;
}
