import { splitText, validateMessages } from './line.mjs';

const CODE_CARD_LIMIT = 2000;
const TABLE_ROW_LIMIT = 8;
const TABLE_COLUMN_LIMIT = 4;

function escapedAt(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function runLength(text, start, character) {
  let end = start;
  while (text[end] === character) end++;
  return end - start;
}

function closingTicks(text, start, count) {
  for (let index = start; index < text.length; index++) {
    if (text[index] !== '`') continue;
    const length = runLength(text, index, '`');
    if (length === count) return index;
    index += length - 1;
  }
  return -1;
}

function bracketEnd(text, start, opening, closing) {
  let depth = 1;
  let quote;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (escapedAt(text, index)) continue;
    if (opening === '(' && (char === '"' || char === "'")) {
      if (quote === char) quote = undefined;
      else if (!quote) quote = char;
      continue;
    }
    if (quote) continue;
    if (char === opening) depth++;
    if (char === closing && --depth === 0) return index;
  }
  return -1;
}

function parseLinkDestination(value) {
  const text = value.trim();
  const angle = text.match(/^<([^>]*)>(?:\s+(["'])([\s\S]*)\2)?$/);
  if (angle) return { url: angle[1], title: angle[3] };
  const bare = text.match(/^(\S+?)(?:\s+(["'])([\s\S]*)\2)?$/);
  if (bare) return { url: bare[1].replace(/\\([()])/g, '$1'), title: bare[3] };
  return undefined;
}

const word = (character) => character !== undefined && /[\p{L}\p{N}_]/u.test(character);

function emphasisEnd(text, start, character, count) {
  const contentStart = start + count;
  if (!text[contentStart] || /\s/u.test(text[contentStart])) return -1;
  // Preserve operators and underscores embedded in identifiers.
  const boundaryWord = character === '_' ? word :
    character === '*' && count === 1 ? (value) => value !== undefined && /[A-Za-z0-9_]/.test(value) : () => false;
  if (boundaryWord(text[start - 1])) return -1;
  for (let index = contentStart; index < text.length; index++) {
    if (text[index] === '\n') return -1;
    if (text[index] !== character || escapedAt(text, index)) continue;
    const length = runLength(text, index, character);
    if (length < count || (count === 1 && length === 2)) { index += length - 1; continue; }
    const closing = index + length - count;
    if (!/\s/u.test(text[closing - 1]) && !boundaryWord(text[closing + count])) return closing;
    index += length - 1;
  }
  return -1;
}

/** Project inline markup into text. Code spans are opaque and links retain URLs. */
function inline(text, depth = 0) {
  if (depth > 12) return text;
  let result = '';
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '\\' && /[\\`*_[\]{}()#+.!|>~-]/.test(text[index + 1] ?? '')) {
      result += text[index + 1];
      index += 2;
      continue;
    }
    if (character === '`') {
      const count = runLength(text, index, '`');
      const end = closingTicks(text, index + count, count);
      if (end >= 0) {
        result += text.slice(index + count, end);
        index = end + count;
        continue;
      }
      result += '`'.repeat(count);
      index += count;
      continue;
    }
    const image = character === '!' && text[index + 1] === '[';
    if (character === '[' || image) {
      const labelStart = index + Number(image);
      const labelEnd = bracketEnd(text, labelStart, '[', ']');
      if (labelEnd >= 0 && text[labelEnd + 1] === '(') {
        const destinationEnd = bracketEnd(text, labelEnd + 1, '(', ')');
        const destination = destinationEnd >= 0
          ? parseLinkDestination(text.slice(labelEnd + 2, destinationEnd)) : undefined;
        if (destination?.url) {
          const label = inline(text.slice(labelStart + 1, labelEnd), depth + 1);
          const url = destination.url;
          result += label && label !== url ? `${label} (${url})` : url;
          if (destination.title) result += ` — ${destination.title}`;
          index = destinationEnd + 1;
          continue;
        }
      }
    }
    if (character === '*' || character === '_' || character === '~') {
      const count = runLength(text, index, character);
      if ((character === '~' && count === 2) || (character !== '~' && count <= 3)) {
        const end = emphasisEnd(text, index, character, count);
        const content = end >= 0 ? text.slice(index + count, end) : '';
        // A Python-style dunder is meaningful identifier text, even outside backticks.
        const dunder = character === '_' && count === 2 && /^[A-Za-z][A-Za-z0-9_]*$/.test(content);
        if (end >= 0 && !dunder) {
          result += inline(content, depth + 1);
          index = end + count;
          continue;
        }
      }
      result += character.repeat(count);
      index += count;
      continue;
    }
    if (character === '<') {
      const end = text.indexOf('>', index + 1);
      const contents = end >= 0 ? text.slice(index + 1, end) : '';
      if (/^https?:\/\/\S+$/i.test(contents)) {
        result += contents;
        index = end + 1;
        continue;
      }
    }
    result += character;
    index++;
  }
  return result;
}

function plain(lines) {
  return lines.map((line, index) => {
    // Setext underlines only count when the preceding line contains a heading.
    if (index > 0 && lines[index - 1].trim() && /^ {0,3}(?:={3,}|-{3,})\s*$/.test(line)) return '';
    const heading = line.match(/^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/);
    const source = heading ? heading[1].replace(/[ \t]+#+[ \t]*$/, '') : line;
    return inline(source);
  }).join('\n');
}

/** Read pipes while preserving pipes inside code spans and escaped cell content. */
function row(line) {
  const source = line.trim();
  const cells = [];
  let cell = '';
  let ticks = 0;
  let pipeCount = 0;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '`') {
      const count = runLength(source, index, '`');
      if (ticks === count) ticks = 0;
      else if (!ticks) ticks = count;
      cell += '`'.repeat(count);
      index += count;
      continue;
    }
    if (character === '|' && !ticks) {
      if (escapedAt(source, index)) cell = `${cell.slice(0, -1)}|`;
      else {
        cells.push(cell.trim());
        cell = '';
        pipeCount++;
      }
    } else cell += character;
    index++;
  }
  cells.push(cell.trim());
  if (source.startsWith('|')) cells.shift();
  if (source.endsWith('|') && !escapedAt(source, source.length - 1) && !ticks) cells.pop();
  return { cells, pipeCount };
}

function readTable(lines, start) {
  if (start + 1 >= lines.length) return undefined;
  const header = row(lines[start]);
  const delimiter = row(lines[start + 1]);
  if (!header.cells.length || !(header.pipeCount || delimiter.pipeCount) || header.cells.length !== delimiter.cells.length ||
      !delimiter.cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return undefined;
  const rows = [];
  let end = start + 2;
  while (end < lines.length && lines[end].trim()) {
    const next = row(lines[end]);
    if (!next.pipeCount) break;
    rows.push(next.cells);
    end++;
  }
  return { header: header.cells, rows, end, source: lines.slice(start, end).join('\n') };
}

function codeCard(code, language) {
  const title = language ? `Code (${language})` : 'Code';
  return {
    type: 'flex', altText: splitText(title, 1500)[0],
    contents: {
      type: 'bubble', size: 'giga',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', backgroundColor: '#F1F5F9',
        contents: [
          { type: 'text', text: splitText(title, 1500)[0], weight: 'bold', size: 'sm', wrap: true, color: '#475569' },
          { type: 'text', text: code, size: 'xs', wrap: true, color: '#0F172A' },
        ],
      },
    },
  };
}

function tableCard(table) {
  const makeRow = (cells, header = false) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: table.header.map((_, index) => ({
      type: 'text', text: inline(cells[index] ?? '') || '—', flex: 1, wrap: true,
      size: 'sm', color: '#0F172A', ...(header ? { weight: 'bold' } : {}),
    })),
  });
  return {
    type: 'flex', altText: splitText(`Table: ${table.header.map((cell) => inline(cell)).join(' / ')}`, 1500)[0],
    contents: {
      type: 'bubble', size: 'giga', body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [makeRow(table.header, true), { type: 'separator' }, ...table.rows.map((cells) => makeRow(cells))],
      },
    },
  };
}

/**
 * Return native LINE message objects in source order. Each object is independently
 * validated; the bridge owns batching them into requests of at most five.
 * User content never becomes an action, callback or remotely fetched image.
 */
export function renderMarkdown(text) {
  if (typeof text !== 'string') throw new TypeError('Markdown text must be a string.');
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const messages = [];
  let pending = [];
  const appendText = (value, literal = false) => {
    const source = literal ? value : value.trim();
    for (const part of splitText(source)) {
      if (!part.trim()) continue;
      const message = { type: 'text', text: part };
      validateMessages([message]);
      messages.push(message);
    }
  };
  const appendRich = (message, fallback) => {
    try { validateMessages([message]); messages.push(message); }
    catch { appendText(fallback, true); }
  };
  const flush = () => { if (pending.length) appendText(plain(pending)); pending = []; };

  for (let index = 0; index < lines.length;) {
    const fence = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*([^\n]*)$/);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const character = fence[1][0];
      const count = fence[1].length;
      let end = index + 1;
      while (end < lines.length) {
        const closing = lines[end].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (closing && closing[1][0] === character && closing[1].length >= count) break;
        end++;
      }
      // An unfinished fence stays visible; no speculative deletion of its content.
      if (end < lines.length) {
        flush();
        const code = lines.slice(index + 1, end).join('\n');
        if (code.trim()) {
          if (code.length <= CODE_CARD_LIMIT) appendRich(codeCard(code, fence[2].trim()), code);
          else appendText(code, true);
        }
        index = end + 1;
        continue;
      }
      flush();
      appendText(lines.slice(index).join('\n'), true);
      index = lines.length;
      continue;
    }
    const table = readTable(lines, index);
    if (table) {
      flush();
      if (table.rows.length <= TABLE_ROW_LIMIT && table.header.length <= TABLE_COLUMN_LIMIT &&
          table.rows.every((cells) => cells.length <= table.header.length)) appendRich(tableCard(table), table.source);
      else appendText(table.source, true);
      index = table.end;
      continue;
    }
    pending.push(lines[index++]);
  }
  flush();
  return messages;
}
