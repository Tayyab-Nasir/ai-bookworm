/** Actual web editor serialization on synthetic parsed DOCX; no server or provider. */
import assert from 'node:assert/strict';
import { BookModelSchema } from '../../packages/book-model/src/schema.ts';
import { editorToNodes, nodesToEditor } from '../../apps/web/components/book-editor-model.ts';

let source = '';
for await (const chunk of process.stdin) {
  source += chunk;
  assert.ok(source.length <= 1_000_000, 'Fixture exceeds editor proof budget');
}
const book = BookModelSchema.parse(JSON.parse(source));
const original = structuredClone(book);
let edits = 0;
const normalized = nodes => nodes.map(node => !Array.isArray(node.attributes?.richText) ? node : ({
  ...node, attributes: { ...node.attributes, richText: node.attributes.richText.map(run =>
    run.type === 'text' ? { ...run, marks: run.marks ?? [] } : run) },
}));
for (const chapter of book.chapters) {
  const editor = nodesToEditor(chapter.nodes);
  const unchanged = editorToNodes(editor, () => assert.fail('Existing block identity lost'));
  assert.deepEqual(normalized(unchanged), normalized(chapter.nodes));
  const block = editor.content.find(item => item.content?.some(run => run.text === 'AFTER MANUAL'));
  if (block) {
    block.content.push({ type: 'text', text: ' Edited.' });
    edits++;
  }
  chapter.nodes = editorToNodes(editor, () => assert.fail('Existing block identity lost'));
}
assert.equal(edits, 1);
assert.deepEqual(book.chapters.flatMap(ch => ch.nodes.filter(n => n.type === 'pageBreak')),
  original.chapters.flatMap(ch => ch.nodes.filter(n => n.type === 'pageBreak')));
assert.deepEqual(book.chapters.map(ch => [ch.id, ch.title]), original.chapters.map(ch => [ch.id, ch.title]));
process.stdout.write(JSON.stringify(BookModelSchema.parse(book)));
