import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:bookworm_mobile/api.dart';
import 'package:bookworm_mobile/chapter_document.dart';
import 'package:bookworm_mobile/manuscript_draft.dart';
import 'package:bookworm_mobile/main.dart' show bookwormTheme;
import 'package:bookworm_mobile/models.dart';
import 'package:bookworm_mobile/screens/manuscript_editor.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final richNode = <String, dynamic>{
  'id': 'n1',
  'type': 'paragraph',
  'text': 'Hello 🌍 world',
  'attributes': {
    'importedStyle': {'spacing': 1.5},
    'richText': [
      {
        'type': 'text',
        'text': 'Hello 🌍',
        'marks': [
          {'type': 'bold'}
        ]
      },
      {
        'type': 'text',
        'text': ' world',
        'marks': [
          {'type': 'italic'}
        ]
      },
    ]
  }
};
final artwork = <String, dynamic>{
  'id': 'art',
  'type': 'image',
  'assetId': '11111111-1111-4111-8111-111111111111',
  'assetVersionNumber': 4,
  'caption': 'Original caption',
  'altText': 'A tree',
  'attributes': {'layout': 'fullBleed', 'cropFocusX': .4}
};
final table = <String, dynamic>{
  'id': 'table',
  'type': 'table',
  'rows': [
    ['A', 'B'],
    ['1', '2']
  ],
  'attributes': {'headerRows': 1}
};
ChapterDocument document(List<Map<String, dynamic>> nodes, [int version = 1]) =>
    ChapterDocument.parse(
        {'chapterId': 'chapter', 'version': version, 'nodes': nodes},
        'chapter');
http.Response json(Object value, [int status = 200]) =>
    http.Response(jsonEncode(value), status,
        headers: {'content-type': 'application/json'});

class ManuscriptFixture {
  ChapterDocument current = document([
    richNode,
    artwork,
    table,
    {'id': 'n2', 'type': 'heading', 'level': 2, 'text': 'Second'}
  ]);
  final receipts = <String, ChapterDocument>{};
  final writes = <Map<String, dynamic>>[];
  bool lostReply = false,
      lostBeforeWrite = false,
      wrongReceipt = false,
      active = true,
      foreignBook = false;
  String role = 'writer';
  int reads = 0;
  Completer<void>? writeGate;
  late final api = ApiClient(
      baseUrl: 'https://api.example.test',
      token: 'synthetic',
      isCurrent: () => active,
      clientFactory: () => MockClient(handle));
  ManuscriptDraft editor(
          {FlutterSecureStorage storage = const FlutterSecureStorage(),
          String owner = 'author'}) =>
      ManuscriptDraft(
          api: api,
          userId: owner,
          workspaceId: 'workspace',
          bookId: 'book',
          chapterId: 'chapter',
          storage: storage);
  Future<http.Response> handle(http.Request request) async {
    if (request.method == 'GET') {
      reads++;
      if (request.url.path.endsWith('/saves')) {
        final id = request.url.queryParameters['operationId']!,
            receipt = receipts[request.url.queryParameters['operationId']];
        return json(receipt == null
            ? {'status': 'not_found', 'operationId': id}
            : {
                'status': 'saved',
                'operationId': id,
                'versionId': 'saved-id',
                'document': receipt.toJson()
              });
      }
      return json({
        'chapter': {
          'id': 'chapter',
          'book_id': foreignBook ? 'foreign' : 'book'
        },
        'role': role,
        'document': current.toJson()
      });
    }
    expect(request.method, 'PUT');
    expect(request.url.path, '/v1/chapters/chapter/document');
    final body = jsonDecode(request.body) as Map<String, dynamic>;
    writes.add(body);
    await writeGate?.future;
    final persisted = await const FlutterSecureStorage().readAll();
    expect(
        persisted.values
            .any((raw) => raw.contains(body['operationId'] as String)),
        isTrue,
        reason: 'Original request must be durable before the network write');
    if (lostBeforeWrite) {
      lostBeforeWrite = false;
      throw http.ClientException('synthetic lost request');
    }
    if (role == 'viewer') return json({}, 403);
    final id = body['operationId'] as String;
    if (!receipts.containsKey(id)) {
      if (body['expectedVersion'] != current.version) return json({}, 409);
      current = document((body['nodes'] as List).cast<Map<String, dynamic>>(),
          current.version + 1);
      receipts[id] = current;
    }
    if (lostReply) {
      lostReply = false;
      throw http.ClientException('synthetic lost response');
    }
    final saved = receipts[id]!;
    return json({
      'version': saved.version,
      'versionId': 'saved-id',
      'document': wrongReceipt
          ? document([
              {'id': 'wrong', 'type': 'paragraph', 'text': 'unrelated'}
            ], saved.version)
              .toJson()
          : saved.toJson()
    });
  }

  void edit(ManuscriptDraft editor, [String text = 'Hello 🌍 author']) =>
      editor.updateNodes([...editor.draft!.nodes]..[0] =
          replaceManuscriptText(editor.draft!.nodes[0], text));
}

class LockedDraftStorage extends FlutterSecureStorage {
  @override
  Future<void> write(
      {required String key,
      required String? value,
      AppleOptions? iOptions,
      AndroidOptions? aOptions,
      LinuxOptions? lOptions,
      WebOptions? webOptions,
      AppleOptions? mOptions,
      WindowsOptions? wOptions}) async {
    throw PlatformException(code: 'device_locked');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
      'canonical documents are immutable and reject malformed or duplicate blocks',
      () {
    final saved = document([richNode, artwork, table]);
    expect(() => saved.nodes.add(richNode), throwsUnsupportedError);
    expect(() => (saved.nodes[0]['attributes'] as Map)['spacing'] = 3,
        throwsUnsupportedError);
    expect(() => document([richNode, richNode]), throwsA(isA<ApiError>()));
    expect(
        () => document([
              {
                'id': 'bad',
                'type': 'table',
                'rows': [3]
              }
            ]),
        throwsA(isA<ApiError>()));
    expect(saved.toJson()['nodes'], [richNode, artwork, table]);
  });

  test('text changes retain formatting, opaque styles, emoji and hard breaks',
      () {
    final edited = replaceManuscriptText(richNode, 'Hello 🌟 author\nNext');
    expect(edited['text'], 'Hello 🌟 author\nNext');
    expect(
        manuscriptRuns(edited)
            .map((run) => run['type'] == 'hardBreak' ? '\n' : run['text'])
            .join(),
        edited['text']);
    expect((edited['attributes'] as Map)['importedStyle'], {'spacing': 1.5});
    expect((manuscriptRuns(edited).first['marks'] as List).first,
        {'type': 'bold'});
    final formatted = toggleManuscriptMark(richNode, 9, 14, 'underline');
    expect(formatted['text'], richNode['text']);
    expect(() => toggleManuscriptMark(richNode, 7, 9, 'bold'),
        throwsA(isA<ApiError>()));
    expect(
        manuscriptRuns({
          'text': 'Canonical',
          'attributes': {
            'richText': [
              {'type': 'text', 'text': 'STALE'}
            ]
          }
        }).single['text'],
        'Canonical');
  });

  test(
      'disjoint block merge preserves both authors and rejects overlapping changes',
      () {
    final base = document([richNode, artwork]);
    final local = base
        .withNodes([replaceManuscriptText(richNode, 'Local words'), artwork]);
    final remote = document([
      richNode,
      {...artwork, 'caption': 'Remote caption'}
    ], 2);
    final merged = mergeManuscript(base, local, remote);
    expect(merged[0]['text'], 'Local words');
    expect(merged[1]['caption'], 'Remote caption');
    expect(
        () => mergeManuscript(
            base,
            local,
            document(
                [replaceManuscriptText(richNode, 'Other words'), artwork], 2)),
        throwsA(isA<ApiError>()));
  });

  test(
      'current document PUT keeps blocks, exact expected version and durable identity',
      () async {
    final server = ManuscriptFixture();
    final draft = server.editor();
    await draft.load();
    server.edit(draft);
    await draft.save();
    expect(draft.message, 'Saved version 2');
    expect(draft.dirty, false);
    expect(server.writes.single['expectedVersion'], 1);
    expect(server.current.nodes[1], artwork);
    expect(server.current.nodes[2], table);
    expect(await const FlutterSecureStorage().readAll(), isEmpty);
    draft.dispose();
  });

  test(
      'lost reply survives restart and read-only recovery finds the original version after later edits',
      () async {
    final server = ManuscriptFixture()..lostReply = true;
    final first = server.editor();
    await first.load();
    server.edit(first);
    await first.save();
    expect(first.phase, ManuscriptPhase.uncertain);
    expect(first.canEdit, false);
    final originalId = first.operationId;
    expect(originalId, isNotNull);
    server.current = document(
        [...server.current.nodes]..[3] = {
            'id': 'n2',
            'type': 'heading',
            'level': 2,
            'text': 'Later collaborator'
          },
        3);
    first.dispose();
    final reopened = server.editor();
    await reopened.load();
    expect(reopened.message, 'Saved version 2');
    expect(reopened.operationId, isNull);
    expect(server.writes.length, 1);
    expect(server.current.version, 3);
    expect(server.receipts.keys, [originalId]);
    reopened.dispose();
  });

  test(
      'unaccepted request retries the same ID and content, never a fresh intent',
      () async {
    final server = ManuscriptFixture()..lostBeforeWrite = true;
    final editor = server.editor();
    await editor.load();
    server.edit(editor);
    await editor.save();
    final originalId = editor.operationId;
    await editor.recover();
    expect(editor.operationId, originalId);
    await editor.save();
    expect(server.writes.length, 2);
    expect(server.writes[0], server.writes[1]);
    expect(server.current.version, 2);
    editor.dispose();
  });

  test(
      'conflict retains exact draft and requires explicit merge then separate save',
      () async {
    final server = ManuscriptFixture();
    final draft = server.editor();
    await draft.load();
    server.edit(draft);
    server.current = document(
        [...server.current.nodes]..[3] = {
            'id': 'n2',
            'type': 'heading',
            'level': 2,
            'text': 'Other author'
          },
        2);
    await draft.save();
    await draft.recover();
    expect(draft.phase, ManuscriptPhase.conflict);
    expect(draft.base!.version, 1);
    expect(draft.draft!.nodes[0]['text'], 'Hello 🌍 author');
    await draft.mergeLatest();
    expect(draft.base!.version, 2);
    expect(draft.draft!.nodes[3]['text'], 'Other author');
    expect(server.writes.length, 1);
    await draft.save();
    expect(server.current.version, 3);
    expect(server.current.nodes[1], artwork);
    draft.dispose();
  });

  test('mismatched success never erases draft; original receipt can recover it',
      () async {
    final server = ManuscriptFixture()..wrongReceipt = true;
    final editor = server.editor();
    await editor.load();
    server.edit(editor);
    await editor.save();
    expect(editor.operationId, isNotNull);
    expect(editor.dirty, true);
    await editor.recover();
    expect(editor.message, 'Saved version 2');
    expect(server.writes.length, 1);
    editor.dispose();
  });

  test('read-only roles and foreign book responses never enable writes',
      () async {
    final server = ManuscriptFixture()..role = 'viewer';
    final editor = server.editor();
    await editor.load();
    expect(() => server.edit(editor), throwsA(isA<ApiError>()));
    await editor.save();
    expect(server.writes, isEmpty);
    editor.dispose();
    server.foreignBook = true;
    final foreign = server.editor();
    await foreign.load();
    expect(foreign.draft, isNull);
    expect(foreign.canSave, false);
    foreign.dispose();
  });

  test('secure storage failure or corrupt scope stops before any remote write',
      () async {
    final server = ManuscriptFixture();
    final locked = server.editor(storage: LockedDraftStorage());
    await locked.load();
    server.edit(locked);
    await locked.save();
    expect(server.writes, isEmpty);
    expect(locked.dirty, true);
    expect(locked.durable, false);
    locked.dispose();
    final corrupt = server.editor();
    FlutterSecureStorage.setMockInitialValues({corrupt.storageKey: '{broken'});
    final previousReads = server.reads;
    await corrupt.load();
    expect(server.reads, previousReads);
    expect(await const FlutterSecureStorage().read(key: corrupt.storageKey),
        '{broken');
    corrupt.dispose();
  });

  test(
      'failed local checkpoint keeps editable text and never dispatches a save',
      () async {
    final server = ManuscriptFixture();
    final editor = server.editor(storage: LockedDraftStorage());
    await editor.load();
    server.edit(editor, 'Keep this text when storage is locked.');
    await editor.checkpointDraft();
    expect(editor.draft!.nodes.first['text'],
        'Keep this text when storage is locked.');
    expect(editor.durable, false);
    expect(editor.canEdit, true);
    expect(editor.operationId, isNull);
    expect(editor.message, contains('could not be stored securely'));
    expect(server.writes, isEmpty);
    editor.dispose();
  });

  test(
      'explicit local discard reloads the current version without cancelling a remote save',
      () async {
    final server = ManuscriptFixture()..lostBeforeWrite = true;
    final editor = server.editor();
    await editor.load();
    server.edit(editor, 'Unconfirmed request');
    await editor.save();
    final original = server.writes.single;
    expect(editor.operationId, original['operationId']);
    await editor.discardAndReload();
    expect(editor.dirty, false);
    expect(editor.operationId, isNull);
    expect(editor.draft!.nodes, server.current.nodes);
    expect(await const FlutterSecureStorage().read(key: editor.storageKey),
        isNull);
    expect(server.writes, hasLength(1));
    expect(server.receipts, isEmpty,
        reason: 'Discard is local only, not a remote cancellation');
    editor.dispose();
  });

  test(
      'account switch fences edits and saves without deleting the original draft',
      () async {
    final server = ManuscriptFixture();
    final draft = server.editor();
    await draft.load();
    server.edit(draft);
    await draft.keepDraft();
    server.active = false;
    await draft.save();
    expect(server.writes, isEmpty);
    expect(await const FlutterSecureStorage().read(key: draft.storageKey),
        isNotNull);
    draft.dispose();
  });

  test(
      'explicit overlapping choices retain other changes and reject stale review',
      () async {
    final server = ManuscriptFixture();
    final editor = server.editor();
    await editor.load();
    server.edit(editor, 'My rewrite');
    server.current = document(
        [...server.current.nodes]
          ..[0] = replaceManuscriptText(richNode, 'Their rewrite')
          ..[3] = {
            'id': 'n2',
            'type': 'heading',
            'level': 2,
            'text': 'Keep their heading'
          },
        2);
    await editor.recover();
    expect(manuscriptConflicts(editor.base!, editor.draft!, editor.latest!),
        ['n1']);
    await editor.mergeLatest();
    expect(editor.base!.version, 1);
    expect(editor.draft!.nodes[0]['text'], 'My rewrite');
    await editor.mergeLatest(localChoices: {'n1': true}, reviewedVersion: 1);
    expect(editor.base!.version, 1);
    expect(editor.message, contains('changed again'));
    await editor.mergeLatest(localChoices: {'n1': true}, reviewedVersion: 2);
    expect(editor.base!.version, 2);
    expect(editor.draft!.nodes[0]['text'], 'My rewrite');
    expect(editor.draft!.nodes[3]['text'], 'Keep their heading');
    expect(server.writes, isEmpty);
    editor.dispose();
  });

  test(
      'structural merge needs explicit order choice and handles deleted conflicts',
      () {
    final base = document([richNode, artwork, table]);
    final local = document([table, richNode, artwork]);
    final remote = document([
      richNode,
      table,
      {...artwork, 'caption': 'Changed remotely'}
    ], 2);
    expect(manuscriptOrderConflict(base, local, remote), true);
    expect(
        () => mergeManuscript(base, local, remote), throwsA(isA<ApiError>()));
    expect(
        mergeManuscript(base, local, remote, localOrder: true)
            .map((node) => node['id']),
        ['table', 'n1', 'art']);
    final removed = document([richNode, table]);
    expect(manuscriptConflicts(base, removed, remote), ['art']);
    expect(
        mergeManuscript(base, removed, remote,
                localChoices: {'art': true}, localOrder: true)
            .map((node) => node['id']),
        ['n1', 'table']);
    final retained = mergeManuscript(base, removed, remote,
        localChoices: {'art': false}, localOrder: true);
    expect(retained.map((node) => node['id']), ['n1', 'table', 'art']);
    expect(retained.last['caption'], 'Changed remotely');
  });

  test(
      'over-limit merge leaves the base, pending identity and exact local draft intact',
      () async {
    final server = ManuscriptFixture();
    final editor = server.editor();
    await editor.load();
    editor.updateNodes([...editor.draft!.nodes]
      ..[0] = {'id': 'n1', 'type': 'paragraph', 'text': 'x' * 2200000});
    final original = editor.draft;
    server.current = document(
        [...server.current.nodes]
          ..[3] = {'id': 'n2', 'type': 'paragraph', 'text': 'y' * 2200000},
        2);
    await editor.save();
    final request = editor.operationId;
    await editor.mergeLatest();
    expect(editor.base!.version, 1);
    expect(identical(editor.draft, original), true);
    expect(editor.operationId, request);
    expect(editor.message, contains('document size'));
    expect(server.writes.length, 1);
    editor.dispose();
  });

  test(
      'parallel save/recover/discard cannot race an in-flight original request',
      () async {
    final server = ManuscriptFixture()..writeGate = Completer<void>();
    final editor = server.editor();
    await editor.load();
    server.edit(editor);
    final saving = editor.save();
    await Future<void>.delayed(Duration.zero);
    expect(editor.busy, true);
    await Future.wait(
        [editor.save(), editor.recover(), editor.discardAndReload()]);
    server.writeGate!.complete();
    await saving;
    expect(server.writes.length, 1);
    expect(server.current.version, 2);
    editor.dispose();
  });

  test(
      'device draft is separate per actor and safe document transport supports more than 2 MiB',
      () async {
    final server = ManuscriptFixture();
    final owner = server.editor();
    await owner.load();
    server.edit(owner);
    await owner.keepDraft();
    final other = server.editor(owner: 'another-author');
    await other.load();
    expect(other.dirty, false);
    final restarted = server.editor();
    await restarted.load();
    expect(restarted.draft!.nodes[0]['text'], 'Hello 🌍 author');
    server.current = document([
      {'id': 'big', 'type': 'paragraph', 'text': 'x' * 2200000}
    ]);
    final received = await server.api.getChapterDocument('chapter', 'book');
    expect((received.document.nodes.single['text'] as String).length, 2200000);
    owner.dispose();
    other.dispose();
    restarted.dispose();
  });

  testWidgets('phone conflict review requires a choice and a separate save',
      (tester) async {
    final server = ManuscriptFixture();
    final draft = server.editor();
    await tester.pumpWidget(MaterialApp(
        home: ManuscriptEditor(editor: draft, title: 'My chapter')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('text-n1')), 'My words');
    await tester.pumpAndSettle();
    server.current = document(
        [...server.current.nodes]..[0] =
            replaceManuscriptText(richNode, 'Other words'),
        2);
    await tester.tap(find.text('Check saved version'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Compare versions'));
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Merge reviewed choices'))
            .onPressed,
        isNull);
    await tester.scrollUntilVisible(find.text('Use my block'), 180,
        scrollable: find
            .descendant(
                of: find.byType(AlertDialog), matching: find.byType(Scrollable))
            .first);
    await tester.ensureVisible(find.text('Use my block'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Use my block'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Merge reviewed choices'));
    await tester.pumpAndSettle();
    expect(server.writes, isEmpty);
    expect(draft.draft!.nodes[0]['text'], 'My words');
    await tester.tap(find.byTooltip('Save manuscript'));
    await tester.pumpAndSettle();
    expect(server.current.version, 3);
    expect(server.writes.length, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    draft.dispose();
  });

  testWidgets('oversized paste is refused before changing the accepted draft',
      (tester) async {
    final server = ManuscriptFixture();
    final draft = server.editor();
    await tester.pumpWidget(MaterialApp(
        home: ManuscriptEditor(editor: draft, title: 'My chapter')));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const ValueKey('text-n1')), 'x' * 2100000);
    await tester.pumpAndSettle();
    expect(draft.dirty, false);
    expect(draft.draft!.nodes.first['text'], richNode['text']);
    expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('text-n1')))
            .controller!
            .text,
        richNode['text']);
    expect(find.textContaining('new input was not accepted'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    draft.dispose();
  });

  testWidgets(
      'adding a block at the chapter size limit keeps the draft and shows a correction',
      (tester) async {
    final server = ManuscriptFixture();
    final node = <String, dynamic>{
      'id': 'n1',
      'type': 'paragraph',
      'text': 'Short visible text',
      'attributes': {'importedData': ''}
    };
    final overhead = utf8.encode(jsonEncode([node])).length;
    node['attributes'] = {'importedData': 'x' * (4000000 - overhead - 10)};
    server.current = document([node]);
    final editor = server.editor();
    await tester.pumpWidget(MaterialApp(
        home: ManuscriptEditor(editor: editor, title: 'Near the limit')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add paragraph'));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(editor.draft!.nodes, hasLength(1));
    expect(find.textContaining('exceeds the supported document size'),
        findsOneWidget);
    expect(server.writes, isEmpty);
    await tester.pumpWidget(const SizedBox());
    editor.dispose();
  }, timeout: const Timeout(Duration(seconds: 25)));

  testWidgets(
      'phone editor saves actual text while preserving rich artwork and table nodes',
      (tester) async {
    final server = ManuscriptFixture();
    final draft = server.editor();
    await tester.pumpWidget(MaterialApp(
        home: ManuscriptEditor(editor: draft, title: 'My chapter')));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const ValueKey('text-n1')), 'Changed on my phone');
    expect(draft.dirty, true);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Save manuscript'));
    await tester.pumpAndSettle();
    expect(find.text('Saved version 2'), findsOneWidget);
    expect(server.current.nodes[0]['text'], 'Changed on my phone');
    expect(server.current.nodes[1], artwork);
    expect(server.current.nodes[2], table);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    draft.dispose();
  });

  testWidgets(
      '320px enlarged-text editor has no overflow and keeps a device draft on exit',
      (tester) async {
    tester.view.physicalSize = const Size(320, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final server = ManuscriptFixture();
    final editor = server.editor();
    await tester.pumpWidget(MaterialApp(
        builder: (_, child) => MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(1.6)),
            child: child!),
        home: Builder(
            builder: (context) => Scaffold(
                body: TextButton(
                    onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                            builder: (_) => ManuscriptEditor(
                                editor: editor,
                                title: 'A long chapter title'))),
                    child: const Text('Open'))))));
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const ValueKey('text-n1')), 'Keep these words');
    expect(editor.dirty, true);
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('Keep your draft?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.byType(ManuscriptEditor), findsOneWidget);
    await tester.enterText(
        find.byKey(const ValueKey('text-n1')), 'Keep these words safely');
    await tester.pump();
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep draft'));
    await tester.pumpAndSettle();
    expect(find.text('Open'), findsOneWidget);
    expect(server.writes, isEmpty);
    expect(await const FlutterSecureStorage().read(key: editor.storageKey),
        contains('Keep these words'));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    editor.dispose();
  });
  testWidgets(
      'typing checkpoints an encrypted draft without a remote save or navigation',
      (tester) async {
    final server = ManuscriptFixture();
    final editor = server.editor();
    await tester.pumpWidget(MaterialApp(
        home: ManuscriptEditor(editor: editor, title: 'My chapter')));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const ValueKey('text-n1')), 'Recover after app closes');
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pumpAndSettle();
    expect(editor.durable, true);
    expect(server.writes, isEmpty);
    await tester.pumpWidget(const SizedBox());
    editor.dispose();
    final reopened = server.editor();
    await reopened.load();
    expect(reopened.draft!.nodes.first['text'], 'Recover after app closes');
    expect(reopened.dirty, true);
    reopened.dispose();
  });

  testWidgets('dark phone manuscript surface renders with accessible controls',
      (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const output = String.fromEnvironment('BOOKWORM_MANUSCRIPT_SCREENSHOT');
    const fontPath = String.fromEnvironment('BOOKWORM_TEST_FONT_PATH');
    if (output.isNotEmpty && fontPath.isNotEmpty)
      await tester.runAsync(() async {
        final bytes = await File(fontPath).readAsBytes();
        await (FontLoader('Roboto')
              ..addFont(Future.value(ByteData.sublistView(bytes))))
            .load();
        final icons = await File(
                '${File(fontPath).parent.path}/MaterialIcons-Regular.otf')
            .readAsBytes();
        await (FontLoader('MaterialIcons')
              ..addFont(Future.value(ByteData.sublistView(icons))))
            .load();
      });
    final server = ManuscriptFixture();
    server.current = document([...server.current.nodes]..[0] =
        replaceManuscriptText(richNode, 'The map had changed overnight.'));
    final editor = server.editor();
    final boundary = GlobalKey();
    await tester.pumpWidget(RepaintBoundary(
        key: boundary,
        child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: bookwormTheme(),
            home: ManuscriptEditor(
                editor: editor, title: 'The Wandering Atlas'))));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Save manuscript'), findsOneWidget);
    expect(find.byKey(const ValueKey('text-n1')), findsOneWidget);
    expect(tester.takeException(), isNull);
    if (output.isNotEmpty)
      await tester.runAsync(() async {
        final rendered = boundary.currentContext!.findRenderObject()
            as RenderRepaintBoundary;
        final image = await rendered.toImage(pixelRatio: 1);
        try {
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(output).writeAsBytes(png!.buffer.asUint8List());
        } finally {
          image.dispose();
        }
      });
    await tester.pumpWidget(const SizedBox());
    editor.dispose();
  });

  testWidgets(
      'block controls format, reorder and remove only after confirmation',
      (tester) async {
    tester.view.physicalSize = const Size(700, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final server = ManuscriptFixture();
    server.current = document([
      {'id': 'first', 'type': 'paragraph', 'text': 'An opening'},
      {'id': 'second', 'type': 'paragraph', 'text': 'Another line'},
    ]);
    final editor = server.editor();
    await tester.pumpWidget(
        MaterialApp(home: ManuscriptEditor(editor: editor, title: 'Draft')));
    await tester.pumpAndSettle();
    final field =
        tester.widget<TextField>(find.byKey(const ValueKey('text-first')));
    field.controller!.selection =
        const TextSelection(baseOffset: 0, extentOffset: 2);
    await tester.tap(find.text('Bold').first);
    await tester.pumpAndSettle();
    expect(manuscriptRuns(editor.draft!.nodes.first).first['marks'], [
      {'type': 'bold'}
    ]);
    await tester.tap(find.byTooltip('Block options').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Heading 1').last);
    await tester.pumpAndSettle();
    expect(editor.draft!.nodes.first['type'], 'heading');
    expect(editor.draft!.nodes.first['level'], 1);
    await tester.tap(find.byTooltip('Block options').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Move up'));
    await tester.pumpAndSettle();
    expect(editor.draft!.nodes.map((n) => n['id']), ['second', 'first']);
    await tester.tap(find.byTooltip('Block options').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove block'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(editor.draft!.nodes, hasLength(2));
    await tester.tap(find.byTooltip('Block options').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove block'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Remove block'));
    await tester.pumpAndSettle();
    expect(editor.draft!.nodes.single['id'], 'first');
    await tester.tap(find.text('Add paragraph'));
    await tester.pumpAndSettle();
    final added = editor.draft!.nodes.last['id'];
    await tester.enterText(
        find.byKey(ValueKey('text-$added')), 'A new paragraph');
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Save manuscript'));
    await tester.pumpAndSettle();
    expect(server.current.version, 2);
    expect(server.current.nodes.last['text'], 'A new paragraph');
    expect(server.current.nodes.first['type'], 'heading');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    editor.dispose();
  }, timeout: const Timeout(Duration(seconds: 25)));
}
