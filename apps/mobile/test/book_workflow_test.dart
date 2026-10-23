import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:bookworm_mobile/api.dart';
import 'package:bookworm_mobile/book_workflow.dart';
import 'package:bookworm_mobile/models.dart';
import 'package:bookworm_mobile/main.dart' show bookwormTheme;
import 'package:bookworm_mobile/screens/assets_screen.dart';
import 'package:bookworm_mobile/screens/book_overview_screen.dart';
import 'package:bookworm_mobile/screens/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'asset_upload_test.dart' as upload;

const bookId = '44444444-4444-4444-8444-444444444444';
const chapterId = '55555555-5555-4555-8555-555555555555';
const importedId = '66666666-6666-4666-8666-666666666666';
const jobId = '77777777-7777-4777-8777-777777777777';
const details = {
  'title': 'The Moon Garden',
  'authorName': 'A. Writer',
  'language': 'en'
};

class BookFixture extends upload.Fixture {
  final books = <String, Map<String, dynamic>>{};
  final chapters = <Map<String, dynamic>>[];
  final chapterRequests = <String, Map<String, dynamic>>{};
  final jobs = <String, Map<String, dynamic>>{};
  final receipts = <String, Map<String, dynamic>>{};
  final tasks = <Map<String, dynamic>>[];
  bool loseTask = false;
  int taskWrites = 0;
  String role = 'owner';
  bool loseBook = false,
      loseChapter = false,
      loseQueue = false,
      loseRetry = false;
  int creates = 0, chapterPosts = 0, queues = 0, retries = 0;
  Map<String, dynamic> bookRow(String id, Map<String, dynamic> values) => {
        'id': id,
        'workspace_id': upload.workspace,
        'created_by': upload.owner,
        'title': values['title'],
        'author_name': values['authorName'],
        'language': values['language'],
        'subtitle': values['subtitle'],
        'genre': values['genre'],
        'status': 'draft'
      };
  void seed() => books[bookId] = bookRow(bookId, details);
  NativeBookWorkflow workflow(
          {bool creating = false,
          String userId = upload.owner,
          FlutterSecureStorage storage = const FlutterSecureStorage()}) =>
      NativeBookWorkflow(
          api: api,
          userId: userId,
          workspaceId: upload.workspace,
          bookId: creating ? null : bookId,
          storage: storage);

  @override
  Future<http.Response> handleApi(http.Request request) async {
    final path = request.url.path, parts = request.url.path.split('/');
    final body = request.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(request.body) as Map<String, dynamic>;
    if (path == '/v1/tasks') return upload.json({'tasks': tasks});
    if (path.startsWith('/v1/tasks/')) {
      taskWrites++;
      tasks.single['status'] = body['status'];
      if (loseTask) throw http.ClientException('lost task reply');
      return upload.json(tasks.single);
    }
    if (path == '/v1/books') {
      if (request.method == 'GET')
        return upload.json({'books': books.values.toList()});
      creates++;
      if (role == 'viewer') return upload.json({}, 403);
      final id = body['requestId'] as String;
      books.putIfAbsent(id, () => bookRow(id, body));
      if (loseBook) {
        loseBook = false;
        throw http.ClientException('lost create reply');
      }
      return upload.json(books[id]!, 201);
    }
    if (parts.length >= 4 && parts[2] == 'books') {
      final id = parts[3];
      if (!books.containsKey(id)) return upload.json({}, 404);
      if (parts.length == 4)
        return upload.json({'book': books[id], 'role': role});
      if (parts[4] == 'chapters') {
        if (request.method == 'GET') return upload.json({'chapters': chapters});
        chapterPosts++;
        final key = body['idempotencyKey'] as String;
        final chapter = chapterRequests.putIfAbsent(key, () {
          final item = {
            'id': chapterId,
            'book_id': id,
            'title': body['title'],
            'order_index': chapters.length,
            'status': 'draft'
          };
          chapters.add(item);
          return item;
        });
        if (loseChapter) {
          loseChapter = false;
          throw http.ClientException('lost chapter reply');
        }
        return upload.json({'chapter': chapter}, 201);
      }
      if (parts[4] == 'import-jobs') {
        if (request.method == 'GET')
          return upload.json({'jobs': jobs.values.toList()});
        if (parts.length > 5) {
          retries++;
          final job = jobs[parts[5]]!;
          job['status'] = 'queued';
          job['attempts'] = 0;
          if (loseRetry) {
            loseRetry = false;
            throw http.ClientException('lost retry reply');
          }
          return upload.json({'job': job}, 202);
        }
        queues++;
        final job = jobs.putIfAbsent(
            jobId,
            () => {
                  'id': jobId,
                  'book_id': id,
                  'source_asset_id': body['assetId'],
                  'status': 'queued',
                  'attempts': 0,
                  'error_code': null,
                  'created_at': '2026-10-23T00:00:00Z',
                  'available_at': '2026-10-23T00:00:00Z',
                  'completed_at': null
                });
        if (loseQueue) {
          loseQueue = false;
          throw http.ClientException('lost queue reply');
        }
        return upload.json({'job': job}, 202);
      }
      if (parts[4] == 'imports')
        return upload.json({'import': receipts[parts[5]]});
    }
    if (parts.length >= 4 && parts[2] == 'chapters') {
      final chapter = chapters.singleWhere((c) => c['id'] == parts[3]);
      return upload.json({
        'chapter': chapter,
        'role': role,
        'document': {
          'chapterId': chapter['id'],
          'version': 1,
          'nodes': [
            {
              'id': 'first',
              'type': 'paragraph',
              'text':
                  chapter['id'] == importedId ? 'Imported manuscript text.' : ''
            }
          ]
        }
      });
    }
    return super.handleApi(request);
  }

  void complete({String? targetBook}) {
    final job = jobs[jobId]!;
    job['status'] = 'succeeded';
    final chapter = {
      'id': importedId,
      'book_id': targetBook ?? bookId,
      'title': 'Imported opening',
      'order_index': chapters.length,
      'status': 'draft'
    };
    chapters.add(chapter);
    receipts[job['source_asset_id'] as String] = {
      'sourceAssetId': job['source_asset_id'],
      'chapters': [chapter],
      'assetIds': <String>[],
      'report': {
        'chapterCount': 1,
        'imageCount': 0,
        'warnings': ['Review imported headings.']
      }
    };
  }
}

Future<AssetItem> source(BookFixture f) async {
  await f.uploader().upload(upload.file(), type: 'manuscript');
  return (await f.api.listAssets(upload.workspace)).single;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    SharedPreferences.setMockInitialValues({});
  });

  test(
      'book reply loss and restart recover the original without another create',
      () async {
    final f = BookFixture()..loseBook = true;
    final first = f.workflow(creating: true);
    await first.refresh();
    await first.create(details);
    expect(first.pendingKind, 'book');
    expect(f.creates, 1);
    final raw = await const FlutterSecureStorage().read(key: first.storageKey);
    expect(raw, isNot(contains('synthetic-access')));
    final second = f.workflow(creating: true);
    await second.refresh();
    expect(second.book?.title, details['title']);
    expect(second.pendingKind, isNull);
    expect(f.creates, 1);
    expect(f.books, hasLength(1));
    await second.create(details);
    expect(f.creates, 1);
  });

  test('missing original book resumes the same stored ID and original metadata',
      () async {
    final f = BookFixture()..role = 'viewer';
    final first = f.workflow(creating: true);
    await first.refresh();
    await first.create(details);
    final saved = jsonDecode(
            (await const FlutterSecureStorage().read(key: first.storageKey))!)
        as Map;
    final id = saved['pending']['id'];
    final second = f.workflow(creating: true);
    f.role = 'owner';
    await second.refresh();
    expect(f.creates, 1);
    await second.create({...details, 'title': 'Changed intent'});
    expect(f.creates, 1);
    await second.resume();
    expect(f.creates, 2);
    expect(second.book?.id, id);
    expect(second.book?.title, details['title']);
  });

  test(
      'locked storage, invalid metadata, corrupted scope and foreign actor fail closed',
      () async {
    final f = BookFixture();
    final locked = f.workflow(creating: true, storage: upload.LockedStorage());
    await locked.refresh();
    await locked.create(details);
    expect(f.creates, 0);
    await locked.resume();
    expect(f.creates, 0);
    final second = f.workflow(creating: true, userId: 'different-user');
    await second.refresh();
    expect(second.pendingKind, isNull);
    await second.create({...details, 'title': ' '});
    expect(f.creates, 0);
    await const FlutterSecureStorage().write(
        key: second.storageKey,
        value: jsonEncode({
          'schema': 1,
          'scope': ['foreign'],
          'pending': {}
        }));
    final invalid = f.workflow(creating: true, userId: 'different-user');
    await invalid.refresh();
    expect(invalid.loaded, isFalse);
    await invalid.create(details);
    expect(f.creates, 0);
    expect(await const FlutterSecureStorage().read(key: invalid.storageKey),
        isNotNull);
    await invalid.discard();
    expect(invalid.loaded, isTrue);
  });

  test('lost chapter reply survives restart and exact retry does not duplicate',
      () async {
    final f = BookFixture()
      ..seed()
      ..loseChapter = true;
    final first = f.workflow();
    await first.refresh();
    await first.addChapter('Opening');
    expect(f.chapters, hasLength(1));
    expect(first.pendingKind, 'chapter');
    final second = f.workflow();
    await second.refresh();
    expect(f.chapterPosts, 1); // Opening and refreshing are read-only.
    f.chapters.single['title'] = 'Renamed by another editor';
    await second.resume();
    expect(f.chapterPosts, 2);
    expect(f.chapters, hasLength(1));
    expect(f.chapterRequests, hasLength(1));
    expect(second.pendingKind, isNull);
    expect(second.chapters.single.title, 'Renamed by another editor');
  });

  test(
      'screened upload, lost queue reply, restart, and receipt recovery preserve originals',
      () async {
    final f = BookFixture()
      ..seed()
      ..loseQueue = true;
    final asset = await source(f);
    final first = f.workflow();
    await first.refresh();
    await first.importAsset(asset);
    expect(f.queues, 1);
    expect(first.pendingKind, 'import');
    final second = f.workflow();
    await second.refresh();
    await second.resume();
    expect(f.queues, 1);
    expect(f.transferCalls, 1);
    expect(second.message, contains('queued'));
    f.jobs[jobId]!['status'] = 'succeeded';
    await second.refresh();
    expect(second.pendingKind, 'import');
    expect(second.message, contains('receipt is unavailable'));
    f.complete();
    await second.refresh();
    expect(second.pendingKind, isNull);
    expect(second.chapters.single.id, importedId);
    expect(
        second.reports[asset.id]?.warnings.single, 'Review imported headings.');
    expect(f.queues, 1);
    expect(f.transferCalls, 1);
  });

  test(
      'failed import retry is explicit, scoped and recoverable after reply loss',
      () async {
    final f = BookFixture()..seed();
    final asset = await source(f);
    final flow = f.workflow();
    await flow.refresh();
    await flow.importAsset(asset);
    f.jobs[jobId]!['status'] = 'failed';
    f.jobs[jobId]!['error_code'] = 'document_dependency_unavailable';
    await flow.refresh();
    expect(f.retries, 0);
    f.loseRetry = true;
    await flow.retryImport(flow.jobs.single);
    expect(f.retries, 1);
    await flow.refresh();
    await flow.resume();
    expect(f.retries, 1);
    expect(f.queues, 1);
    expect(flow.jobs.single.status, 'queued');
  });

  test(
      'viewer, changed source, scan quarantine, size and unsupported format never enqueue',
      () async {
    final f = BookFixture()..seed();
    final asset = await source(f);
    final flow = f.workflow();
    await flow.refresh();
    f.role = 'viewer';
    await flow.addChapter('Forbidden');
    await flow.importAsset(asset);
    expect(f.chapterPosts, 0);
    expect(f.queues, 0);
    expect(flow.canEdit, isFalse);
    f.role = 'owner';
    final row = f.records[asset.id]!;
    row['checksum'] = 'b' * 64;
    await flow.importAsset(asset);
    expect(f.queues, 0);
    row['checksum'] = asset.checksum;
    for (final bad in ['pending', 'infected', 'error']) {
      row['current_scan_status'] = bad;
      await flow.importAsset(asset);
      expect(f.queues, 0);
    }
    row['current_scan_status'] = 'clean';
    row['size_bytes'] = maxManuscriptImportBytes + 1;
    await flow.importAsset(asset);
    expect(f.queues, 0);
    row['size_bytes'] = asset.sizeBytes;
    row['name'] = 'source.md';
    await flow.importAsset(asset);
    expect(f.queues, 0);
    f.current = false;
    await flow.addChapter('Switched');
    expect(f.chapterPosts, 0);
  });

  test(
      'pending import never swaps a source or deletes server data on local discard',
      () async {
    final f = BookFixture()..seed();
    final asset = await source(f);
    final flow = f.workflow();
    await flow.refresh();
    await flow.importAsset(asset);
    await flow.addChapter('Blocked');
    expect(f.chapterPosts, 0);
    await flow.importAsset(asset);
    expect(f.queues, 1);
    await flow.discard();
    expect(f.jobs, hasLength(1));
    expect(f.records, hasLength(1));
    expect(flow.pendingKind, isNull);
  });

  test(
      'malformed book/chapter/job/receipt responses are safe ApiErrors, never cast errors',
      () async {
    Object body = {};
    final api = ApiClient(
        baseUrl: 'https://api.example.test',
        token: 'synthetic',
        clientFactory: () => MockClient((_) async => upload.json(body)));
    final invalid = throwsA(
        isA<ApiError>().having((e) => e.code, 'code', 'invalid_response'));
    for (final rows in [
      null,
      0,
      [
        {'id': 'private', 'workspace_id': 'foreign'}
      ]
    ]) {
      body = {'books': rows};
      await expectLater(api.listBooks(upload.workspace), invalid);
      body = {'chapters': rows};
      await expectLater(api.listChapters(bookId), invalid);
      body = {'jobs': rows};
      await expectLater(api.listImportJobs(bookId), invalid);
      body = {'tasks': rows};
      await expectLater(api.listTasks(upload.workspace), invalid);
    }
    body = {};
    await expectLater(api.getImportReport(bookId, jobId), invalid);
    body = {
      'import': {
        'sourceAssetId': jobId,
        'chapters': [
          {'id': importedId, 'book_id': 'foreign'}
        ],
        'assetIds': [],
        'report': {'warnings': [], 'chapterCount': 1, 'imageCount': 0}
      }
    };
    await expectLater(api.getImportReport(bookId, jobId), invalid);
    body = {
      'job': {
        'id': jobId,
        'book_id': bookId,
        'source_asset_id': 'foreign',
        'status': 'queued',
        'attempts': 0
      }
    };
    await expectLater(api.queueImport(bookId, importedId), invalid);
  });

  test(
      'double taps dispatch one create, and a late reply after account switch is rejected',
      () async {
    final held = Completer<http.Response>();
    var current = true, writes = 0;
    final flow = NativeBookWorkflow(
        userId: upload.owner,
        workspaceId: upload.workspace,
        api: ApiClient(
            baseUrl: 'https://api.example.test',
            token: 'synthetic',
            isCurrent: () => current,
            clientFactory: () => MockClient((request) async {
                  writes++;
                  return held.future;
                })));
    await flow.refresh();
    final saving = flow.create(details);
    await Future<void>.delayed(Duration.zero);
    await flow.create(details);
    expect(writes, 1);
    current = false;
    held.complete(upload.json({}));
    await saving;
    expect(flow.book, isNull);
    expect(flow.pendingKind, 'book');
    expect(flow.message, contains('account or workspace changed'));
  });

  testWidgets(
      'phone journey creates, recovers, imports and opens the actual manuscript editor',
      (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final f = BookFixture()..loseBook = true;
    final asset = await tester.runAsync(() => source(f));
    final auth = await f.auth(tester);
    await tester.pumpWidget(MaterialApp(
        theme: ThemeData.dark(useMaterial3: true),
        home: HomeScreen(auth: auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create a book'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'Book title'), details['title']!);
    await tester.enterText(find.widgetWithText(TextField, 'Author or pen name'),
        details['authorName']!);
    await tester.scrollUntilVisible(find.text('Create private book'), 250,
        scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Create private book'));
    await tester.pumpAndSettle();
    expect(find.text('Resume saved action'), findsOneWidget);
    await tester.tap(find.text('Resume saved action'));
    await tester.pumpAndSettle();
    expect(f.creates, 1);
    await tester.tap(find.text('Open book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Import manuscript'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(asset!.name));
    await tester.pumpAndSettle();
    expect(f.queues, 0);
    await tester.tap(find.widgetWithText(FilledButton, 'Import manuscript'));
    await tester.pumpAndSettle();
    expect(f.queues, 1);
    expect(find.textContaining('Import queued.'), findsOneWidget);
    final newId = f.books.keys.single;
    f.complete(targetBook: newId);
    await tester.tap(find.byTooltip('Refresh book and imports'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Imported opening'), 200);
    await tester.tap(find.text('Imported opening'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('text-first')), findsOneWidget);
    expect(find.text('Imported manuscript text.'), findsOneWidget);
    expect(tester.takeException(), isNull);
    expect(f.transferCalls, 1);
  }, timeout: const Timeout(Duration(seconds: 25)));

  testWidgets(
      'manuscript picker uploads real bytes, and narrow large-text layout stays usable',
      (tester) async {
    tester.view.physicalSize = const Size(320, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final f = BookFixture();
    final auth = await f.auth(tester);
    await tester.pumpWidget(MaterialApp(
        builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(1.6)),
            child: child!),
        home: AssetsScreen(
            auth: auth,
            selectManuscript: true,
            selectFile: () async => upload.file(),
            storageClientFactory: f.storageTransport)));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Choose file and upload'), 200);
    await tester.tap(find.text('Choose file and upload'));
    await tester.pumpAndSettle();
    expect(f.transferCalls, 0);
    await tester.tap(find.text('Upload file'));
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(f.transferCalls, 1);
    expect(f.queues, 0);
    await tester.scrollUntilVisible(find.text('manuscript.txt'), 200);
    expect(find.text('manuscript.txt'), findsOneWidget);
    expect(tester.takeException(), isNull);
  }, timeout: const Timeout(Duration(seconds: 25)));

  testWidgets(
      'chapter and failed-import UI require explicit actions on a narrow screen',
      (tester) async {
    tester.view.physicalSize = const Size(320, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final f = BookFixture()
      ..seed()
      ..loseChapter = true;
    final asset = await tester.runAsync(() => source(f));
    final auth = await f.auth(tester);
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(1.6)),
            child: child!),
        home: BookOverviewScreen(
            auth: auth, book: Book.fromJson(f.books[bookId]!))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add chapter'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'Chapter title'), 'Opening');
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(f.chapterPosts, 0);
    await tester.tap(find.text('Add chapter'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'Chapter title'), 'Opening');
    await tester.tap(find.widgetWithText(FilledButton, 'Add chapter').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Resume saved action'));
    await tester.pumpAndSettle();
    expect(f.chapters, hasLength(1));
    expect(f.chapterPosts, 2);
    await tester.tap(find.text('Import manuscript'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text(asset!.name), 150);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text(asset.name));
    await tester.pumpAndSettle();
    await tester.tap(find.text(asset.name));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(f.queues, 0);
    await tester.tap(find.text('Import manuscript'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text(asset.name), 150);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text(asset.name));
    await tester.pumpAndSettle();
    await tester.tap(find.text(asset.name));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Import manuscript'));
    await tester.pumpAndSettle();
    f.jobs[jobId]!['status'] = 'failed';
    await tester.tap(find.byTooltip('Refresh book and imports'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Retry original import'), 250);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Retry original import'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Retry original import'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(f.retries, 0);
    await tester.tap(find.text('Retry original import'));
    await tester.pumpAndSettle();
    await tester
        .tap(find.widgetWithText(FilledButton, 'Retry original import'));
    await tester.pumpAndSettle();
    expect(f.retries, 1);
    expect(f.chapters, hasLength(1));
    await tester.tap(find.text('Check import receipt'));
    await tester.pumpAndSettle();
    expect(f.queues, 1);
    expect(tester.takeException(), isNull);
  }, timeout: const Timeout(Duration(seconds: 25)));

  testWidgets(
      'local discard confirms consequences and viewer controls remain disabled',
      (tester) async {
    final f = BookFixture()
      ..seed()
      ..loseChapter = true;
    final flow = f.workflow();
    await flow.refresh();
    await flow.addChapter('Existing chapter');
    f.role = 'viewer';
    final auth = await f.auth(tester);
    await tester.pumpWidget(MaterialApp(
        home: BookOverviewScreen(
            auth: auth, book: Book.fromJson(f.books[bookId]!))));
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Add chapter'))
            .onPressed,
        isNull);
    await tester.tap(find.text('Resume saved action'));
    await tester.pumpAndSettle();
    expect(f.chapterPosts, 1);
    await tester.tap(find.text('Discard local retry details'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep details'));
    await tester.pumpAndSettle();
    expect(find.text('Resume saved action'), findsOneWidget);
    await tester.tap(find.text('Discard local retry details'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard local details'));
    await tester.pumpAndSettle();
    expect(find.text('Resume saved action'), findsNothing);
    expect(f.chapters, hasLength(1));
    expect(tester.takeException(), isNull);
  }, timeout: const Timeout(Duration(seconds: 25)));

  testWidgets(
      'home task reply loss stays recoverable without an uncaught UI error',
      (tester) async {
    final f = BookFixture()
      ..seed()
      ..loseTask = true;
    f.tasks.add({
      'id': 'task',
      'workspace_id': upload.workspace,
      'title': 'Review headings',
      'priority': 'medium',
      'status': 'todo'
    });
    final auth = await f.auth(tester);
    await tester.pumpWidget(MaterialApp(home: HomeScreen(auth: auth)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review headings'));
    await tester.pumpAndSettle();
    expect(f.taskWrites, 1);
    expect(find.textContaining('service could not be reached'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester
        .widget<RefreshIndicator>(find.byType(RefreshIndicator))
        .onRefresh();
    await tester.pumpAndSettle();
    expect(find.text('No open tasks'), findsOneWidget);
    expect(f.taskWrites, 1);
  }, timeout: const Timeout(Duration(seconds: 25)));

  testWidgets('book overview renders the reviewed phone surface',
      (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const output = String.fromEnvironment('BOOKWORM_BOOK_SCREENSHOT');
    const fonts = String.fromEnvironment('BOOKWORM_TEST_FONT_DIRECTORY');
    if (output.isNotEmpty && fonts.isNotEmpty) {
      await tester.runAsync(() async {
        for (final font in {
          'Roboto': 'roboto-regular.ttf',
          'MaterialIcons': 'materialicons-regular.otf'
        }.entries) {
          final bytes = await File('$fonts/${font.value}').readAsBytes();
          await (FontLoader(font.key)
                ..addFont(Future.value(ByteData.sublistView(bytes))))
              .load();
        }
      });
    }
    final f = BookFixture()..seed();
    final asset = await tester.runAsync(() => source(f));
    final flow = f.workflow();
    await flow.refresh();
    await flow.importAsset(asset!);
    f.complete();
    final auth = await f.auth(tester), boundary = GlobalKey();
    await tester.pumpWidget(RepaintBoundary(
        key: boundary,
        child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: bookwormTheme(),
            home: BookOverviewScreen(
                auth: auth, book: Book.fromJson(f.books[bookId]!)))));
    await tester.pumpAndSettle();
    expect(find.text('Imported opening'), findsOneWidget);
    expect(find.text('Review imported headings.'), findsOneWidget);
    expect(tester.takeException(), isNull);
    if (output.isNotEmpty)
      await tester.runAsync(() async {
        final image = await (boundary.currentContext!.findRenderObject()
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 1);
        try {
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(output).writeAsBytes(png!.buffer.asUint8List());
        } finally {
          image.dispose();
        }
      });
  }, timeout: const Timeout(Duration(seconds: 25)));
}
