import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPublicResult, renderPublicAgent } from '../public/public-agent.js';

test('public results format headings, paragraphs, lists and quoted evidence', () => {
  const html = formatPublicResult('## Findings\n\nA **measured** change.\nSecond line.\n\n- First finding\n- Second finding\n\n1. Verify evidence\n2. Record date\n\n> Quoted evidence\n> continues here.');
  assert.match(html, /<h4>Findings<\/h4>/);
  assert.match(html, /<p>A <strong>measured<\/strong> change\. Second line\.<\/p>/);
  assert.match(html, /<ul><li>First finding<\/li><li>Second finding<\/li><\/ul>/);
  assert.match(html, /<ol><li>Verify evidence<\/li><li>Record date<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>Quoted evidence continues here\.<\/p><\/blockquote>/);
  assert.doesNotMatch(html, /## Findings|&gt; Quoted/);
});

test('only HTTPS source links become safe external anchors', () => {
  const html = formatPublicResult('[Source & evidence](https://ethereum.org/en/?a=1&b=2)\n\nSource: https://example.org/report.');
  assert.match(html, /href="https:\/\/ethereum\.org\/en\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Source &amp; evidence<\/a>/);
  assert.match(html, /href="https:\/\/example\.org\/report"[^>]+>https:\/\/example\.org\/report<\/a>\./);
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'http://example.org', '//example.org', 'https://user:pass@example.org', 'https://example.org:444/', 'https://example.org/"onmouseover="bad', 'https://example.org\\@evil.test/']) {
    assert.doesNotMatch(formatPublicResult(`[source](${url})`), /<a\b/, url);
  }
});

test('raw HTML and image syntax remain escaped text without remote embeds', () => {
  const html = formatPublicResult('<script>alert(1)</script>\n\n<svg onload="alert(1)"><a xlink:href="javascript:bad">x</a></svg>\n\n![tracking pixel](https://example.org/pixel.png)\n\n[<img src=x onerror=bad>](https://example.org/)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /!\[tracking pixel\]\(https:\/\/example\.org\/pixel\.png\)/);
  assert.match(html, /&lt;img src=x onerror=bad&gt;<\/a>/);
  assert.doesNotMatch(html, /<(?:script|svg|img|iframe|object|embed)\b|(?:href|src)="(?:javascript|data):/i);
  assert.equal((html.match(/<a /g) || []).length, 1);
});

test('inline and fenced code stay literal, including unclosed fences', () => {
  const html = formatPublicResult('Use `https://example.org/` literally.\n\n```html\n<img src=x onerror=bad>\n[link](https://example.org/)\n```');
  assert.match(html, /<code>https:\/\/example\.org\/<\/code>/);
  assert.match(html, /<pre><code>&lt;img src=x onerror=bad&gt;\n\[link\]\(https:\/\/example\.org\/\)<\/code><\/pre>/);
  assert.doesNotMatch(html, /<a\b|<img\b/);
  assert.equal(formatPublicResult('```\n<script>'), '<pre><code>&lt;script&gt;</code></pre>');
});

test('public formatting rejects oversized or non-string content without truncating', () => {
  assert.equal(formatPublicResult('a'.repeat(32000)).length, 32007);
  assert.throws(() => formatPublicResult('a'.repeat(32001)), /unavailable/);
  assert.throws(() => formatPublicResult({ toString: () => '<script>' }), /unavailable/);
  const page = { slug:'s', title:'Shared results', description:'', artifacts:[{title:'Result 1',content:'x'.repeat(32001),mode:'zkapi'}] };
  assert.throws(() => renderPublicAgent({page}, 's'), /unavailable/);
});
