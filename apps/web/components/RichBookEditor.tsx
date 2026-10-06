"use client";

import { useEditor, useEditorState, EditorContent, Extension, Node, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { OrderedList } from "@tiptap/extension-list";
import { useEffect, useRef, useState } from "react";
import type { Chapter as ModelChapter, BookNode } from "@bookworm/book-model";
import { editorToNodes, nodesToEditor, LIST_NUMBER_TYPES, listNumberStyle, listNumberStyleFromType, listStart } from "./book-editor-model";
import { ArtworkPicker, ManuscriptBlockView } from "./ManuscriptArtwork";

export type EditorPermission = "editor" | "viewer";
export interface EditorValidationError { message: string; draftText: string }
export interface EditorDocument { chapterId: string; version: number; nodes: BookNode[] }
export interface RichBookEditorProps {
  document: EditorDocument; permissions: EditorPermission;
  workspaceId: string;
  onChange: (nodes: BookNode[]) => void;
  onValidationChange?: (error: EditorValidationError | null) => void;
}

const CanonicalAttributes = Extension.create({
  name: "canonicalAttributes",
  addGlobalAttributes() {
    return [{ types: ["paragraph","heading","blockquote","listItem","preservedBlock"], attributes: {
      nodeId: { default: null, rendered: false }, canonical: { default: null, rendered: false },
    } }];
  },
});

const PreservedBlock = Node.create({
  name: "preservedBlock", group: "block", atom: true, selectable: true,
  addNodeView() { return ReactNodeViewRenderer(ManuscriptBlockView); },
  parseHTML() { return []; },
  renderHTML({ node }) {
    const original = node.attrs.canonical as BookNode | undefined;
    const label = original?.type === "image" ? "Illustration" : original?.type === "pageBreak" ? "Page break" : original?.type ?? "Imported block";
    return ["div", { class: "my-4 rounded-lg border border-dashed border-white/20 px-4 py-3 text-sm text-white/60", contenteditable: "false" }, `${label}${original?.text ? `: ${original.text}` : ""} · preserved in manuscript`];
  },
});

// HTML type selectors are case-insensitive; bind the safe style to the native list type.
const NumberedList = OrderedList.extend({
  addAttributes() {
    return { ...this.parent!(), reversed: { default: false, parseHTML: element => element.hasAttribute("reversed"),
      renderHTML: attributes => attributes.reversed === true ? { reversed: "reversed" } : {} } };
  },
  renderHTML({ HTMLAttributes }) {
    const style = listNumberStyleFromType(HTMLAttributes.type);
    return ["ol", { ...HTMLAttributes, type: LIST_NUMBER_TYPES[style], style: `list-style-type:${style}` }, 0];
  },
});

export function chapterToPmDoc(chapter: ModelChapter) { return nodesToEditor(chapter.nodes); }

export default function RichBookEditor({ document, permissions, workspaceId, onChange, onValidationChange }: RichBookEditorProps) {
  const [artworkOpen, setArtworkOpen] = useState(false);
  const [numberingError, setNumberingError] = useState<string | null>(null);
  const [startInput, setStartInput] = useState("1");
  const artworkPosition = useRef<number | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const validationRef = useRef(onValidationChange);
  validationRef.current = onValidationChange;
  const editor = useEditor({
    extensions: [StarterKit.configure({ codeBlock: false, horizontalRule: false, link: false, orderedList: false }), NumberedList, CanonicalAttributes, PreservedBlock],
    editable: permissions === "editor", immediatelyRender: false, content: nodesToEditor(document.nodes),
    editorProps: { attributes: { class: "min-h-[540px] break-words font-serif outline-none text-[17px] leading-8 text-[#29251f] [&_h1]:my-6 [&_h1]:text-3xl [&_h2]:my-5 [&_h2]:text-2xl [&_h3]:text-xl [&_p]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-black/30 [&_blockquote]:pl-5 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:pl-6 [&_ol]:list-decimal [&_ol]:list-inside [&_ol>li]:my-3 [&_ol>li>p:first-child]:inline", "aria-label": "Manuscript editor", role: "textbox", "aria-multiline": "true" } },
    onUpdate({ editor: current, transaction: update }) {
      // Changing edit permissions emits an update too; it is not a manuscript edit.
      if (!update.docChanged) return;
      const seen = new Set<string>();
      const transaction = current.state.tr;
      current.state.doc.descendants((node, position) => {
        if (!("nodeId" in node.attrs)) return true;
        const id = node.attrs.nodeId;
        if (!id || seen.has(id)) {
          const nextId = crypto.randomUUID();
          transaction.setNodeMarkup(position, undefined, { ...node.attrs, nodeId: nextId });
          seen.add(nextId);
        } else seen.add(id);
        return true;
      });
      if (transaction.docChanged) { current.view.dispatch(transaction); return; }
      try {
        const nodes = editorToNodes(current.getJSON(), () => crypto.randomUUID());
        setNumberingError(null); validationRef.current?.(null); changeRef.current(nodes);
      } catch (reason) {
        if (!(reason instanceof RangeError)) throw reason;
        setNumberingError(reason.message);
        validationRef.current?.({ message: reason.message, draftText: current.getText({ blockSeparator: "\n\n",
          textSerializers: { preservedBlock: ({ node }) => typeof node.attrs.canonical?.text === "string" ? node.attrs.canonical.text : "" } }) });
      }
    },
  });

  useEffect(() => { editor?.setEditable(permissions === "editor"); }, [editor, permissions]);
  const active = useEditorState({ editor, selector: ({ editor: current }) => ({ bold: current?.isActive("bold") ?? false, italic: current?.isActive("italic") ?? false, undo: current?.can().undo() ?? false, redo: current?.can().redo() ?? false,
    ordered: current?.isActive("orderedList") ?? false, listStart: listStart(current?.getAttributes("orderedList").start) ?? 1,
    listReversed: current?.getAttributes("orderedList").reversed === true,
    listNumberStyle: listNumberStyleFromType(current?.getAttributes("orderedList").type) }) });
  useEffect(() => { setStartInput(String(active?.listStart ?? 1)); }, [active?.listStart]);
  const insertBlock = (node: BookNode) => {
    if (!editor?.isEditable) return;
    const position = node.type === "image" ? artworkPosition.current ?? editor.state.selection.to : editor.state.selection.to;
    editor.chain().focus().insertContentAt(position, { type: "preservedBlock", attrs: { nodeId: node.id, canonical: node } }).run();
    artworkPosition.current = null;
    setArtworkOpen(false);
  };

  const buttonStyle = "min-h-11 rounded-md border border-white/15 px-3 py-1.5 text-xs outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white aria-pressed:bg-white/15 disabled:opacity-40";
  return <div className="rounded-2xl border border-white/10 bg-white/[0.025]">
    {permissions === "editor" && <div className="flex flex-wrap gap-2 border-b border-white/10 p-3" aria-label="Text formatting">
      <button type="button" className={buttonStyle} aria-pressed={active?.bold} onClick={() => editor?.chain().focus().toggleBold().run()}>Bold</button>
      <button type="button" className={buttonStyle} aria-pressed={active?.italic} onClick={() => editor?.chain().focus().toggleItalic().run()}>Italic</button>
      <button type="button" className={buttonStyle} onClick={() => editor?.chain().focus().setParagraph().run()}>Paragraph</button>
      <button type="button" className={buttonStyle} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>Heading 1</button>
      <button type="button" className={buttonStyle} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Heading 2</button>
      <button type="button" className={buttonStyle} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>Quote</button>
      <button type="button" className={buttonStyle} onClick={() => editor?.chain().focus().toggleBulletList().run()}>Bullets</button>
      <button type="button" className={buttonStyle} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>Numbered list</button>
      {active?.ordered && <>
        <label className="flex min-h-11 items-center gap-2 text-xs">Numbering<select aria-label="Numbering style" value={active.listNumberStyle} className="max-w-36 rounded-md border border-white/15 bg-black p-2 focus-visible:ring-2 focus-visible:ring-white" onChange={event => editor?.chain().updateAttributes("orderedList", { type: LIST_NUMBER_TYPES[listNumberStyle(event.target.value)] }).run()}>
          <option value="decimal">1, 2, 3</option><option value="lower-alpha">a, b, c</option><option value="upper-alpha">A, B, C</option><option value="lower-roman">i, ii, iii</option><option value="upper-roman">I, II, III</option>
        </select></label>
        <label className="flex min-h-11 items-center gap-2 text-xs">Start at<input aria-label="Start list at" type="number" min={1} max={1_000_000} step={1} value={startInput} className="w-24 rounded-md border border-white/15 bg-black p-2 focus-visible:ring-2 focus-visible:ring-white" onBlur={() => { if (listStart(Number(startInput)) === undefined) setStartInput(String(active.listStart)); }} onChange={event => { setStartInput(event.target.value); const start = listStart(event.target.valueAsNumber); if (start !== undefined) editor?.chain().updateAttributes("orderedList", { start }).run(); }} /></label>
        <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" aria-label="Reverse list numbering" checked={active.listReversed} onChange={event => editor?.chain().updateAttributes("orderedList", { reversed: event.target.checked }).run()} />Reverse numbering</label>
      </>}
      <button type="button" className={buttonStyle} onClick={() => { artworkPosition.current = editor?.state.selection.to ?? null; setArtworkOpen(true); }} disabled={!editor}>Illustration</button>
      <button type="button" className={buttonStyle} onClick={() => insertBlock({ id: crypto.randomUUID(), type: "pageBreak" })} disabled={!editor}>Page break</button>
      <button type="button" className={buttonStyle} onClick={() => insertBlock({ id: crypto.randomUUID(), type: "table", rows: [["", ""], ["", ""]], text: "\t\n\t" })} disabled={!editor}>Table</button>
      <button type="button" className={buttonStyle} disabled={!active?.undo} onClick={() => editor?.chain().focus().undo().run()}>Undo</button>
      <button type="button" className={buttonStyle} disabled={!active?.redo} onClick={() => editor?.chain().focus().redo().run()}>Redo</button>
    </div>}
    {permissions === "viewer" && <p className="px-6 pt-4 text-sm text-white/50">Read-only access</p>}
    {numberingError && <p role="alert" className="px-6 py-3 text-sm text-red-200">{numberingError} These edits have not been sent to save.</p>}
    <div className="rounded-b-2xl bg-[#f5f1e8] px-5 py-8 sm:px-10 lg:px-12"><EditorContent editor={editor} /></div>
    {artworkOpen && permissions === "editor" && <ArtworkPicker workspaceId={workspaceId} onInsert={insertBlock} onClose={() => { setArtworkOpen(false); editor?.commands.focus(); }} />}
  </div>;
}
