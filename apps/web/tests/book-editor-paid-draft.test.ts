import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("chapter creation writes only the chapter; a draft brief prefills the paid assistant without automatic counting or purchase", () => {
  const source = readFileSync(new URL("../components/BookEditorClient.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("BookEditorClient.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let creation: ts.Node | undefined;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "createChapter") creation = node.initializer;
    ts.forEachChild(node, find);
  };
  find(tree);
  assert.ok(creation, "chapter creation handler must be inspected");
  const apiCalls: string[] = [], calls: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node.expression.getText(tree));
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(tree) === "api") apiCalls.push(node.expression.name.text);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(creation);
  assert.deepEqual(apiCalls, ["createChapter"]);
  assert.ok(calls.includes("setInitialDraftInstruction"));
  assert.ok(calls.includes("setDraftPlanTargetChapterId"));
  assert.doesNotMatch(source, /api\.createAiJob|retryableAiDraft|pendingDraft/);
  assert.match(source, /initialDraftInstruction=\{document\?\.chapterId === draftPlanTargetChapterId \? initialDraftInstruction : undefined\}/);
  assert.match(creation.getText(tree), /pendingRestore/);
});
