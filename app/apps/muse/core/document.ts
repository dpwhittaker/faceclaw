import { parseAbc } from './abc';
import type { Score } from './score-types';

/**
 * What Muse shows, independent of sizes: a column of text paragraphs, rules
 * and music. Markdown is read for its structure only (headings, paragraphs,
 * lists, quotes, rules, code fences); inline markup is dropped, since the
 * glasses get one face. A fenced ```abc block becomes music.
 */

export type FileKind = 'markdown' | 'text' | 'abc';

/** title = #, heading = ##, subheading = ### and below. */
export type TextStyle = 'title' | 'heading' | 'subheading' | 'body' | 'code';

export type DocItem =
  | {
      kind: 'text';
      style: TextStyle;
      /** Plain text; '\n' is a line break the layout must keep. */
      text: string;
      /** List marker shown before the first line ("•", "1."). */
      marker?: string;
      /** List nesting depth. */
      indent: number;
      quote: boolean;
    }
  | { kind: 'rule' }
  | { kind: 'music'; score: Score };

export type MuseDocument = { items: DocItem[]; hasText: boolean; hasMusic: boolean };

export function fileKind(name: string): FileKind | null {
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.(txt|text)$/i.test(name)) return 'text';
  if (/\.abc$/i.test(name)) return 'abc';
  return null;
}

/** Build a document from a file's body (its front matter already removed). */
export function buildDocument(body: string, kind: FileKind): MuseDocument {
  const items = kind === 'markdown' ? parseMarkdown(body) : kind === 'abc' ? abcItems(body, true) : parsePlainText(body);
  return {
    items,
    hasText: items.some((item) => item.kind === 'text'),
    hasMusic: items.some((item) => item.kind === 'music'),
  };
}

function textItem(text: string, style: TextStyle = 'body', extra: Partial<Extract<DocItem, { kind: 'text' }>> = {}): DocItem {
  return { kind: 'text', style, text, indent: 0, quote: false, ...extra };
}

/** Each tune's title (when wanted), one music item per verse, then its W: words as stanzas. */
export function abcItems(source: string, showTitles: boolean): DocItem[] {
  const items: DocItem[] = [];
  for (const tune of parseAbc(source)) {
    if (showTitles && tune.title) items.push(textItem(tune.title, 'heading'));
    for (const score of tune.verses) items.push({ kind: 'music', score });
    let stanza: string[] = [];
    const flush = () => {
      if (stanza.length) items.push(textItem(stanza.join('\n')));
      stanza = [];
    };
    for (const line of tune.words) {
      if (line) stanza.push(line);
      else flush();
    }
    flush();
  }
  return items;
}

/** Plain text: paragraphs between blank lines, keeping every line break. */
export function parsePlainText(text: string): DocItem[] {
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^\n+|\s+$/g, ''))
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => textItem(paragraph));
}

// ── Markdown ───────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

function headingStyle(level: number): TextStyle {
  return level === 1 ? 'title' : level === 2 ? 'heading' : 'subheading';
}

export function parseMarkdown(source: string): DocItem[] {
  const items: DocItem[] = [];
  const lines = source.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  // The paragraph (or list item, or quote) being gathered.
  let open: { parts: string[]; marker?: string; indent: number; quote: boolean } | null = null;

  const close = () => {
    if (!open) return;
    const text = joinParagraph(open.parts);
    if (text.trim()) items.push(textItem(text, 'body', { marker: open.marker, indent: open.indent, quote: open.quote }));
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      close();
      const marker = fence[1];
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith(marker[0].repeat(marker.length)) && !lines[i].trim().slice(marker.length).trim()) break;
        body.push(lines[i]);
      }
      if (fence[2].toLowerCase() === 'abc') items.push(...abcItems(body.join('\n'), false));
      else if (body.some((l) => l.trim())) items.push(textItem(body.join('\n').replace(/\s+$/, ''), 'code'));
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      close();
      items.push(textItem(inlineText(atx[2] ?? ''), headingStyle(atx[1].length)));
      continue;
    }
    // Setext: a paragraph line underlined with === or ---.
    if (open && !open.marker && !open.quote && open.parts.length === 1 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const text = joinParagraph(open.parts);
      open = null;
      items.push(textItem(text, line.trim()[0] === '=' ? 'title' : 'heading'));
      continue;
    }
    if (RULE.test(line)) {
      close();
      items.push({ kind: 'rule' });
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      close();
      const bullet = /^\d/.test(list[2]) ? `${parseInt(list[2], 10)}.` : '•';
      open = { parts: [list[3]], marker: bullet, indent: Math.floor(list[1].replace(/\t/g, '    ').length / 2), quote: false };
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      if (!open?.quote) {
        close();
        open = { parts: [], indent: 0, quote: true };
      }
      if (quote[1].trim()) open.parts.push(quote[1]);
      else {
        close();
        open = { parts: [], indent: 0, quote: true };
      }
      continue;
    }
    if (open) open.parts.push(line.trim() ? line : '');
    else open = { parts: [line], indent: 0, quote: false };
  }
  close();
  return items;
}

/**
 * Join a paragraph's source lines, keeping each line break (as Obsidian and
 * GitHub comments show them, not as strict Markdown joins them): a script
 * written one beat per line reads that way. A trailing backslash, Markdown's
 * explicit break, is dropped.
 */
function joinParagraph(parts: string[]): string {
  return parts.map((raw) => inlineText(raw.replace(/\\$/, '').trim())).join('\n');
}

const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!>~|])/g;
const ESCAPE_BASE = 0xe000;

/** Markdown inline markup to plain text: links and images keep their text, emphasis and code lose their marks. */
export function inlineText(source: string): string {
  return source
    .replace(ESCAPABLE, (_, c: string) => String.fromCharCode(ESCAPE_BASE + c.charCodeAt(0)))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`+([^`]+?)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
    .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - ESCAPE_BASE));
}
