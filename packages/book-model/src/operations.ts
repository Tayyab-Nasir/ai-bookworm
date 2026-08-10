import { z } from "zod";
import { BookNodeSchema } from "./schema.js";

const envelope = {
  operationId: z.string().min(1),
  target: z.object({ chapterId: z.string().min(1), nodeId: z.string().min(1) }),
  source: z.enum(["human", "ai"]).default("human"),
  sourceRef: z.string().nullable().default(null),
  expectedVersion: z.number().int().min(0),
};

export const InsertNodeOp = z.object({
  ...envelope,
  type: z.literal("insert_node"),
  payload: z.object({
    parentId: z.string().min(1),
    index: z.number().int().min(0),
    node: BookNodeSchema,
  }),
});

export const DeleteNodeOp = z.object({
  ...envelope,
  type: z.literal("delete_node"),
  payload: z.object({ nodeId: z.string().min(1) }),
});

export const MoveNodeOp = z.object({
  ...envelope,
  type: z.literal("move_node"),
  payload: z.object({
    nodeId: z.string().min(1),
    parentId: z.string().min(1),
    index: z.number().int().min(0),
  }),
});

export const ReplaceTextOp = z.object({
  ...envelope,
  type: z.literal("replace_text"),
  payload: z.object({
    nodeId: z.string().min(1),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    text: z.string(),
  }),
});

export const SetAttributeOp = z.object({
  ...envelope,
  type: z.literal("set_attribute"),
  payload: z.object({
    nodeId: z.string().min(1),
    key: z.string().min(1),
    value: z.unknown(),
  }),
});

export const AttachAssetOp = z.object({
  ...envelope,
  type: z.literal("attach_asset"),
  payload: z.object({
    nodeId: z.string().min(1),
    assetId: z.string().uuid(),
    role: z.string(),
  }),
});

export const DetachAssetOp = z.object({
  ...envelope,
  type: z.literal("detach_asset"),
  payload: z.object({ nodeId: z.string().min(1), assetId: z.string().uuid() }),
});

export const SplitNodeOp = z.object({
  ...envelope,
  type: z.literal("split_node"),
  payload: z.object({ nodeId: z.string().min(1), offset: z.number().int().min(0) }),
});

export const MergeNodesOp = z.object({
  ...envelope,
  type: z.literal("merge_nodes"),
  payload: z.object({
    leftNodeId: z.string().min(1),
    rightNodeId: z.string().min(1),
  }),
});

export const DocumentOperationSchema = z.discriminatedUnion("type", [
  InsertNodeOp,
  DeleteNodeOp,
  MoveNodeOp,
  ReplaceTextOp,
  SetAttributeOp,
  AttachAssetOp,
  DetachAssetOp,
  SplitNodeOp,
  MergeNodesOp,
]);
export type DocumentOperation = z.infer<typeof DocumentOperationSchema>;
