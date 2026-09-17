import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../src/utilities/index.js';

describe('markdownToHtml', () => {
  it.each(['', ' \t\n'])('returns an empty string for blank input: %j', (markdown) => {
    expect(markdownToHtml(markdown)).toBe('');
  });

  it('renders headings, paragraphs, and inline formatting synchronously', () => {
    expect(markdownToHtml('# Hello\n\n**Bold**, *italic*, ~~removed~~, and `code`.')).toBe(
      '<h1>Hello</h1>\n<p><strong>Bold</strong>, <em>italic</em>, <del>removed</del>, and <code>code</code>.</p>',
    );
  });

  it('renders nested lists and blockquotes', () => {
    expect(markdownToHtml('- First\n  - Nested\n- Second\n\n> Quoted')).toBe(
      '<ul>\n<li>First\n<ul>\n<li>Nested</li>\n</ul>\n</li>\n<li>Second</li>\n</ul>\n' +
        '<blockquote>\n<p>Quoted</p>\n</blockquote>',
    );
  });

  it('renders tables', () => {
    expect(markdownToHtml('| Name |\n| --- |\n| Ada |')).toBe(
      '<table>\n<thead>\n<tr>\n<th>Name</th>\n</tr>\n</thead>\n' +
        '<tbody>\n<tr>\n<td>Ada</td>\n</tr>\n</tbody>\n</table>',
    );
  });

  it('escapes fenced code without interpreting its Markdown or HTML', () => {
    expect(markdownToHtml('```html\n<strong>**text** & more</strong>\n```')).toBe(
      '<pre><code class="language-html">&lt;strong&gt;**text** &amp; more&lt;/strong&gt;\n</code></pre>',
    );
  });

  it('renders links and images and escapes their attributes', () => {
    expect(markdownToHtml('[Docs](https://example.com "A & B") ![A & B](/image.png)')).toBe(
      '<p><a href="https://example.com" title="A &amp; B">Docs</a> <img src="/image.png" alt="A &amp; B" /></p>',
    );
  });

  it('escapes embedded HTML', () => {
    expect(markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;\n&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it.each(['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,boom'])(
    'clears unsafe link and image URLs: %s',
    (url) => {
      const html = markdownToHtml(`[link](${url}) ![image](${url})`);
      expect(html).toBe('<p><a href="">link</a> <img src="" alt="image" /></p>');
    },
  );

  it('requires double tildes for strikethrough', () => {
    expect(markdownToHtml('~keep~ and ~~remove~~')).toBe('<p>~keep~ and <del>remove</del></p>');
  });

  it('decodes character references and preserves Unicode', () => {
    expect(markdownToHtml('Zoë &copy; &#x1F600; &amp; &lt;')).toBe('<p>Zoë © 😀 &amp; &lt;</p>');
  });

  it('keeps reference definitions local to each conversion', () => {
    expect(markdownToHtml('[link][id]\n\n[id]: /docs')).toBe('<p><a href="/docs">link</a></p>\n');
    expect(markdownToHtml('[link][id]')).toBe('<p>[link][id]</p>');
  });
});
