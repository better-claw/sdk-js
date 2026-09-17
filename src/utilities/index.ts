import { micromark } from 'micromark';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';

const options = {
  allowDangerousHtml: false,
  allowDangerousProtocol: false,
  extensions: [gfmTable(), gfmStrikethrough({ singleTilde: false })],
  htmlExtensions: [gfmTableHtml(), gfmStrikethroughHtml()],
};

/**
 * Convert Markdown to an HTML fragment in Node or the browser.
 * Supports tables and strikethrough in addition to CommonMark syntax.
 * Embedded HTML is escaped and unsafe link/image URLs are cleared.
 */
export function markdownToHtml(markdown: string): string {
  return micromark(markdown, options);
}
