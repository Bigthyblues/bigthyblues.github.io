import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPostBody } from "../src/lib/post-markdown.ts";

const cases = [
  ["[color=fizz]Fizz[/color]", '<span class="md-color md-color-fizz">Fizz</span>'],
  ["[hex=#abc]text[/hex]", '<span class="md-hex" style="color: #abc;">text</span>'],
  ["[hex=#123456]text[/hex]", '<span class="md-hex" style="color: #123456;">text</span>'],
  ["[bg=#ffe49b]text[/bg]", '<span class="md-bg-custom" style="background-color: #ffe49b;">text</span>'],
  ["[bg=soft-blue]text[/bg]", '<span class="md-bg md-bg-soft-blue">text</span>'],
  ...["small", "large", "xl"].map((size) => [`[size=${size}]text[/size]`, `<span class="md-size-${size}">text</span>`]),
  ...["center", "mark", "box"].map((tag) => [`[${tag}]text[/${tag}]`, `<span class="md-${tag}">text</span>`]),
  ["[del]text[/del]", "<del>text</del>"],
  ["**[color=fizz]Fizz[/color]**", '<strong><span class="md-color md-color-fizz">Fizz</span></strong>'],
  ["*text*", "<em>text</em>"],
  ["`text`", "<code>text</code>"],
  ["[site](/posts.html)", '<a href="/posts.html">site</a>'],
  ['![cat](/img/questions/question-30.png)', '<img src="/img/questions/question-30.png" alt="cat" loading="lazy" decoding="async" data-image-component="manual" />']
];
for (const [markdown, expected] of cases) {
  assert.equal(renderPostBody(markdown), `<p>${expected}</p>`, markdown);
}

assert.equal(renderPostBody("# One\n## Two\n### Three\n> Quote\n- Item"),
  "<h3>One</h3><h4>Two</h4><h5>Three</h5><blockquote>Quote</blockquote><p>&bull; Item</p>");
assert.match(renderPostBody("| Name |\n| :---: |\n| [color=fizz]Fizz[/color] |"),
  /<td class="md-table-align-center"><span class="md-color md-color-fizz">Fizz<\/span><\/td>/);
assert.match(renderPostBody("```html\n[color=fizz]<script>[/color]\n```"),
  /<code>\[color=fizz\]&lt;script&gt;\[\/color\]<\/code>/);
assert.equal(renderPostBody('<script>alert("x")</script>'), "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
assert.doesNotMatch(renderPostBody("[bad](javascript:alert)"), /<a /);
assert.doesNotMatch(renderPostBody("[hex=#bad;]text[/hex]"), /<span/);

assert.equal(renderPostBody("I love[color=fizz] Fizz [/color]very much"),
  '<p>I love<span class="md-color md-color-fizz"> Fizz </span>very much</p>');
for (const page of ["posts", "questions"]) {
  const source = readFileSync(new URL(`../src/pages/${page}.astro`, import.meta.url), "utf8");
  assert.match(source, /import .*renderPostBody.*from "\.\.\/lib\/post-markdown"/);
  assert.match(source, /set:html=\{(?:post\.)?bodyHtml\}/);
}
console.log("Posts/Questions Markdown checks passed.");
