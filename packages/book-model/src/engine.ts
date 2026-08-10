import { randomUUID } from "node:crypto";
import type { BookModel, Chapter } from "./schema.js";
import type { DocumentOperation } from "./operations.js";

export class VersionConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Version conflict: expected ${expected}, actual ${actual}`);
    this.name = "VersionConflictError";
  }
}
export class NodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`);
    this.name = "NodeNotFoundError";
  }
}
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const nodeIndex = (c: Chapter, id: string) => c.nodes.findIndex((n) => n.id === id);

function locate(book: BookModel, nodeId: string) {
  for (const c of book.chapters) {
    const i = nodeIndex(c, nodeId);
    if (i !== -1) return { chapter: c, index: i, node: c.nodes[i] };
  }
  throw new NodeNotFoundError(nodeId);
}

const requireText = (book: BookModel, nodeId: string) => {
  const l = locate(book, nodeId);
  if (typeof l.node.text !== "string")
    throw new ValidationError(`Node ${nodeId} (${l.node.type}) has no text`);
  return { ...l, text: l.node.text };
};

/** Immutable array replace-in-place helpers. */
const removeAt = <T>(a: readonly T[], i: number): T[] => a.filter((_, j) => j !== i);
const insertAt = <T>(a: readonly T[], i: number, v: T): T[] => [...a.slice(0, i), v, ...a.slice(i)];
const setAt = <T>(a: readonly T[], i: number, v: T): T[] => a.map((x, j) => (j === i ? v : x));

function putChapter(book: BookModel, chapter: Chapter): BookModel {
  return {
    ...book,
    chapters: book.chapters.map((c) => (c.id === chapter.id ? chapter : c)),
  };
}

/**
 * Pure: applies one validated operation to an immutable copy of the book.
 * Throws VersionConflictError before any work when expectedVersion is stale.
 */
export function applyOperation(
  book: BookModel,
  op: DocumentOperation,
  currentVersion: number,
): { book: BookModel; version: number } {
  if (op.expectedVersion !== currentVersion)
    throw new VersionConflictError(op.expectedVersion, currentVersion);

  let next: BookModel;

  switch (op.type) {
    case "insert_node": {
      // Chapter is the only parent container in the v1 model; parentId is validated
      // against the target chapter so cross-chapter inserts fail loudly.
      const chapter = book.chapters.find((c) => c.id === op.target.chapterId);
      if (!chapter) throw new NodeNotFoundError(op.target.chapterId);
      if (op.payload.parentId !== chapter.id)
        throw new ValidationError(
          `parentId ${op.payload.parentId} is not chapter ${chapter.id}`,
        );
      if (op.payload.index > chapter.nodes.length)
        throw new ValidationError(`index ${op.payload.index} out of bounds`);
      if (book.chapters.some((c) => nodeIndex(c, op.payload.node.id) !== -1))
        throw new ValidationError(`duplicate node id ${op.payload.node.id}`);
      next = putChapter(book, {
        ...chapter,
        nodes: insertAt(chapter.nodes, op.payload.index, op.payload.node),
      });
      break;
    }

    case "delete_node": {
      const { chapter, index } = locate(book, op.payload.nodeId);
      next = putChapter(book, { ...chapter, nodes: removeAt(chapter.nodes, index) });
      break;
    }

    case "move_node": {
      const src = locate(book, op.payload.nodeId);
      const chapter = book.chapters.find((c) => c.id === op.target.chapterId);
      if (!chapter) throw new NodeNotFoundError(op.target.chapterId);
      if (op.payload.parentId !== chapter.id)
        throw new ValidationError(
          `parentId ${op.payload.parentId} is not chapter ${chapter.id}`,
        );
      const adjusted =
        src.chapter.id === chapter.id && src.index < op.payload.index
          ? op.payload.index - 1
          : op.payload.index;
      const srcNodes = removeAt(src.chapter.nodes, src.index);
      if (src.chapter.id === chapter.id) {
        if (adjusted > srcNodes.length) throw new ValidationError("index out of bounds");
        next = putChapter(book, {
          ...chapter,
          nodes: insertAt(srcNodes, adjusted, src.node),
        });
      } else {
        if (adjusted > chapter.nodes.length) throw new ValidationError("index out of bounds");
        next = putChapter(putChapter(book, { ...src.chapter, nodes: srcNodes }), {
          ...chapter,
          nodes: insertAt(chapter.nodes, adjusted, src.node),
        });
      }
      break;
    }

    case "replace_text": {
      const { chapter, index, node, text } = requireText(book, op.payload.nodeId);
      if (op.payload.from > op.payload.to || op.payload.to > text.length)
        throw new ValidationError(
          `range [${op.payload.from}, ${op.payload.to}] out of bounds for length ${text.length}`,
        );
      next = putChapter(book, {
        ...chapter,
        nodes: setAt(chapter.nodes, index, {
          ...node,
          text: text.slice(0, op.payload.from) + op.payload.text + text.slice(op.payload.to),
        }),
      });
      break;
    }

    case "set_attribute": {
      const { chapter, index, node } = locate(book, op.payload.nodeId);
      if (op.payload.key === "level") {
        const v = op.payload.value;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 6)
          throw new ValidationError("level must be an integer 1..6");
        next = putChapter(book, {
          ...chapter,
          nodes: setAt(chapter.nodes, index, { ...node, level: v }),
        });
      } else {
        next = putChapter(book, {
          ...chapter,
          nodes: setAt(chapter.nodes, index, {
            ...node,
            attributes: { ...node.attributes, [op.payload.key]: op.payload.value },
          }),
        });
      }
      break;
    }

    case "attach_asset": {
      const asset = book.assets.find((a) => a.id === op.payload.assetId);
      if (!asset) throw new NodeNotFoundError(`asset ${op.payload.assetId}`);
      const { chapter, index, node } = locate(book, op.payload.nodeId);
      next = {
        ...putChapter(book, {
          ...chapter,
          nodes: setAt(chapter.nodes, index, { ...node, assetId: asset.id }),
        }),
        assets: book.assets.map((a) => (a.id === asset.id ? { ...a, role: op.payload.role } : a)),
      };
      break;
    }

    case "detach_asset": {
      const { chapter, index, node } = locate(book, op.payload.nodeId);
      if (node.assetId !== op.payload.assetId)
        throw new ValidationError(
          `node ${node.id} is not attached to asset ${op.payload.assetId}`,
        );
      next = putChapter(book, {
        ...chapter,
        nodes: setAt(chapter.nodes, index, { ...node, assetId: null }),
      });
      break;
    }

    case "split_node": {
      const { chapter, index, node, text } = requireText(book, op.payload.nodeId);
      if (op.payload.offset > text.length)
        throw new ValidationError(`offset ${op.payload.offset} out of bounds`);
      const right = { ...node, id: randomUUID(), text: text.slice(op.payload.offset) };
      next = putChapter(book, {
        ...chapter,
        nodes: insertAt(
          setAt(chapter.nodes, index, { ...node, text: text.slice(0, op.payload.offset) }),
          index + 1,
          right,
        ),
      });
      break;
    }

    case "merge_nodes": {
      const left = requireText(book, op.payload.leftNodeId);
      const right = requireText(book, op.payload.rightNodeId);
      if (left.chapter.id !== right.chapter.id)
        throw new ValidationError("cannot merge nodes across chapters");
      if (left.index + 1 !== right.index)
        throw new ValidationError("nodes are not adjacent");
      next = putChapter(book, {
        ...left.chapter,
        nodes: setAt(
          removeAt(left.chapter.nodes, right.index),
          left.index,
          { ...left.node, text: left.text + right.text },
        ),
      });
      break;
    }
  }

  return { book: next, version: currentVersion + 1 };
}
