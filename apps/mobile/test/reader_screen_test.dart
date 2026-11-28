import 'dart:convert';

import 'package:bookworm_mobile/auth.dart';
import 'package:bookworm_mobile/models.dart';
import 'package:bookworm_mobile/screens/reader_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Reuse the same synthetic authentication and manuscript contracts as their
// focused suites. Importing helpers does not execute those files' main methods.
import 'auth_state_test.dart' show supabase, account, workspace;
import 'manuscript_test.dart' show ManuscriptFixture, json;

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  testWidgets(
      'reader mounts the scoped editor and safely recovers chapter comments',
      (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final client = (await tester.runAsync(() async => supabase()))!;
    final manuscript = ManuscriptFixture();
    final comments = <Map<String, dynamic>>[];
    var malformed = true, loseReply = false, posts = 0;
    final auth = await tester.runAsync(() async {
      await account(client, 'author');
      final state = AuthState(
          client: client,
          preferences: await SharedPreferences.getInstance(),
          apiBaseUrl: 'https://api.example.test',
          webBaseUrl: 'https://web.example.test',
          clientFactory: () => MockClient((request) async {
                if (request.url.path == '/v1/workspaces')
                  return json({
                    'workspaces': [workspace('workspace')]
                  });
                if (request.url.path == '/v1/comments') {
                  if (request.method == 'GET')
                    return json({'comments': malformed ? null : comments});
                  posts++;
                  final body = jsonDecode(request.body) as Map<String, dynamic>;
                  expect(body['workspaceId'], 'workspace');
                  expect(body['entityId'], 'chapter');
                  final saved = {
                    'id': 'comment-$posts',
                    'workspace_id': 'workspace',
                    'entity_type': 'chapter',
                    'entity_id': 'chapter',
                    'author_id': 'author',
                    'body': body['body']
                  };
                  comments.add(saved);
                  if (loseReply)
                    throw http.ClientException('synthetic lost reply');
                  return json(saved, 201);
                }
                return manuscript.handle(request);
              }));
      await state.start();
      await state.refreshWorkspaces();
      return state;
    });
    addTearDown(() async {
      auth!.dispose();
      await tester.runAsync(client.dispose);
    });
    final chapter = Chapter(
        id: 'chapter',
        bookId: 'book',
        orderIndex: 0,
        title: 'An opening',
        status: 'draft');
    await tester.pumpWidget(MaterialApp(
        home: ReaderScreen(
            auth: auth!, chapter: chapter, workspaceId: 'workspace')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('text-n1')), findsOneWidget);
    await tester.tap(find.byTooltip('Chapter comments'));
    await tester.pumpAndSettle();
    expect(
        find.text(
            'Comments could not be loaded. Your manuscript was not changed.'),
        findsOneWidget);
    expect(tester.takeException(), isNull);
    malformed = false;
    await tester.tap(find.text('Refresh comments'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Write a comment'),
        'Keep the voice consistent.');
    await tester.tap(find.text('Post comment'));
    await tester.pumpAndSettle();
    expect(find.text('Keep the voice consistent.'), findsOneWidget);
    expect(posts, 1);
    loseReply = true;
    await tester.enterText(find.widgetWithText(TextField, 'Write a comment'),
        'Keep this uncertain note.');
    await tester.tap(find.text('Post comment'));
    await tester.pumpAndSettle();
    expect(
        find.text(
            'The comment could not be confirmed. Refresh comments before posting again.'),
        findsOneWidget);
    expect(find.text('Keep this uncertain note.'), findsOneWidget);
    await tester.tap(find.text('Refresh comments'));
    await tester.pumpAndSettle();
    expect(posts, 2, reason: 'Read-only refresh must never repost the comment');
    expect(find.text('Keep this uncertain note.'), findsNWidgets(2));
    expect(manuscript.writes, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    await tester.pumpWidget(MaterialApp(
        home: ReaderScreen(
            auth: auth, chapter: chapter, workspaceId: 'foreign')));
    await tester.pumpAndSettle();
    expect(
        find.text('Select the correct workspace before opening this chapter.'),
        findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  }, timeout: const Timeout(Duration(seconds: 25)));
}
