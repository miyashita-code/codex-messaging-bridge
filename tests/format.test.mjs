import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/format.mjs';
import { validateMessages } from '../src/line.mjs';

function flexTexts(message) {
  const values = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'text' && typeof node.text === 'string') values.push(node.text);
    Object.values(node).forEach(walk);
  };
  walk(message.contents);
  return values;
}

test('headings, emphasis and links project into readable text without losing link destinations', () => {
  const messages = renderMarkdown('# 見出し\n\n**太字**と*強調*、_italic_、~~obsolete~~。\n[公式](https://example.com/path?q=a_b "タイトル")');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[0].text, '見出し\n\n太字と強調、italic、obsolete。\n公式 (https://example.com/path?q=a_b) — タイトル');
  validateMessages(messages);
});

test('inline code, operators, escaped markup and identifier underscores retain meaningful content', () => {
  const [message] = renderMarkdown('`foo_bar **literal** [x](y)`\nfoo_bar_baz __init__ user_id a*b*c\n\\*literal\\* \\_name\\_ C:\\Users\\Alice\n`  spaces  `');
  assert.equal(message.text, 'foo_bar **literal** [x](y)\nfoo_bar_baz __init__ user_id a*b*c\n*literal* _name_ C:\\Users\\Alice\n  spaces');
  // Spaces inside a code span stay intact when they are not outer paragraph whitespace.
  assert.equal(renderMarkdown('before `  spaces  ` after')[0].text, 'before   spaces   after');
  assert.equal(renderMarkdown('**bold *nested italic***')[0].text, 'bold nested italic');
});

test('short fenced code becomes a valid Flex card and surrounding message order is retained', () => {
  const source = 'Before.\n\n```js\nconst user_id = "**literal**";\nconsole.log("https://example.com");\n```\n\nAfter.';
  const messages = renderMarkdown(source);
  assert.deepEqual(messages.map((message) => message.type), ['text', 'flex', 'text']);
  assert.equal(messages[0].text, 'Before.');
  assert.equal(messages[2].text, 'After.');
  assert.equal(messages[1].altText, 'Code (js)');
  assert.deepEqual(flexTexts(messages[1]), ['Code (js)', 'const user_id = "**literal**";\nconsole.log("https://example.com");']);
  assert(Buffer.byteLength(JSON.stringify(messages[1].contents)) <= 30000);
  messages.forEach((message) => validateMessages([message]));
  assert(!JSON.stringify(messages[1]).includes('fontFamily'));
});

test('large fenced code is complete text with safe UTF-16 boundaries', () => {
  const code = `${'a'.repeat(4999)}😀\n${'value_with_underscores();\n'.repeat(250)}`;
  const messages = renderMarkdown(`~~~python\n${code}\n~~~`);
  assert(messages.every((message) => message.type === 'text'));
  assert.equal(messages.map((message) => message.text).join(''), code);
  assert(messages.every((message) => message.text.length <= 5000));
  assert(messages.every((message) => !/[\uD800-\uDBFF]$/.test(message.text)));
  messages.forEach((message) => validateMessages([message]));
});

test('code-card boundary and unfinished fences preserve authored content', () => {
  assert.equal(renderMarkdown(`\`\`\`\n${'a'.repeat(2000)}\n\`\`\``)[0].type, 'flex');
  assert.equal(renderMarkdown(`\`\`\`\n${'a'.repeat(2001)}\n\`\`\``)[0].type, 'text');
  const unfinished = '```js\n**do not change**\nuser_id';
  assert.equal(renderMarkdown(unfinished)[0].text, unfinished);
  assert.deepEqual(renderMarkdown('```\n\n```'), []);
});

test('small Markdown tables become valid Flex rows with all cells retained', () => {
  const messages = renderMarkdown('Before\n\n| **項目** | 値 |\n| :--- | ---: |\n| user_id | `a_b` |\n| 費用 | 1,000円 |\n\nAfter');
  assert.deepEqual(messages.map((message) => message.type), ['text', 'flex', 'text']);
  assert.deepEqual(flexTexts(messages[1]), ['項目', '値', 'user_id', 'a_b', '費用', '1,000円']);
  messages.forEach((message) => validateMessages([message]));
});

test('escaped pipes and pipes/backslashes inside table code spans do not corrupt columns', () => {
  const [message] = renderMarkdown('| A | B |\n| --- | --- |\n| one\\|two | `x\\|y` |\n| `x|y` | [文書](https://example.com/a_b) |');
  assert.equal(message.type, 'flex');
  assert.deepEqual(flexTexts(message), ['A', 'B', 'one|two', 'x\\|y', 'x|y', '文書 (https://example.com/a_b)']);
  validateMessages([message]);
});

test('large or oversized tables stay complete text, including overflow cells', () => {
  const long = ['| A | B |', '| --- | --- |', ...Array.from({ length: 9 }, (_, i) => `| row_${i} | value_${i} |`)].join('\n');
  const fiveColumns = '| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |';
  const overflow = '| A | B |\n| --- | --- |\n| 1 | 2 | important_extra |';
  const oversized = `| A | B |\n| --- | --- |\n| ${'文'.repeat(11000)} | Z |`;
  for (const source of [long, fiveColumns, overflow, oversized]) {
    const messages = renderMarkdown(source);
    assert(messages.every((message) => message.type === 'text'));
    assert.equal(messages.map((message) => message.text).join(''), source);
    messages.forEach((message) => validateMessages([message]));
  }
});

test('fence and table cards are interleaved in original source order and have no actions', () => {
  const messages = renderMarkdown('first\n```text\n/card action "bad" --actions "Run|/danger"\n```\nsecond\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nthird\n```text\n[[buttons: /danger]]\n```\nlast');
  assert.deepEqual(messages.map((message) => message.type), ['text', 'flex', 'text', 'flex', 'text', 'flex', 'text']);
  assert.deepEqual(messages.filter((message) => message.type === 'text').map((message) => message.text), ['first', 'second', 'third', 'last']);
  const serialized = JSON.stringify(messages);
  assert(!serialized.includes('"action":'));
  assert(!serialized.includes('"quickReply":'));
  assert(!serialized.includes('"type":"image"'));
  messages.forEach((message) => validateMessages([message]));
});

test('ordinary long prose is safely chunked and literal URLs/images stay readable', () => {
  const source = `${'語'.repeat(5001)}\n![写真](https://example.com/photo.png)\n<https://example.com/a_b>`;
  const messages = renderMarkdown(source);
  assert(messages.every((message) => message.type === 'text'));
  assert.equal(messages.map((message) => message.text).join(''), `${'語'.repeat(5001)}\n写真 (https://example.com/photo.png)\nhttps://example.com/a_b`);
  messages.forEach((message) => validateMessages([message]));
  assert.deepEqual(renderMarkdown(''), []);
  assert.deepEqual(renderMarkdown('   \n\n'), []);
  assert.throws(() => renderMarkdown(null), TypeError);
});
