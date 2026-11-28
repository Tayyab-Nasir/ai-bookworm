import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:bookworm_mobile/api.dart';
import 'package:bookworm_mobile/chapter_document.dart';
import 'package:bookworm_mobile/main.dart' show bookwormTheme;
import 'package:bookworm_mobile/manuscript_artwork.dart';
import 'package:bookworm_mobile/manuscript_table.dart';
import 'package:bookworm_mobile/models.dart';
import 'package:bookworm_mobile/screens/manuscript_artwork_editor.dart';
import 'package:bookworm_mobile/screens/manuscript_editor.dart';
import 'package:bookworm_mobile/screens/manuscript_table_editor.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart' hide TableCell;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'manuscript_test.dart' show ManuscriptFixture, document;

const artId = '11111111-1111-4111-8111-111111111111';
const artPath = 'workspaces/workspace/assets/$artId/v2/forest.png';
Map<String, dynamic> grid([List<List<String>>? rows]) => {
      'id': 'table',
      'type': 'table',
      'rows': rows ??
          [
            ['Name', 'Place'],
            ['Fox', 'Forest'],
            ['Owl', 'Tree']
          ],
      'attributes': {
        'tableHeaderRows': 1,
        'importedStyle': {'spacing': 1.4}
      },
      'provenance': 'retained'
    };
http.Response json(Object value, [int status = 200]) =>
    http.Response(jsonEncode(value), status,
        headers: {'content-type': 'application/json'});

Future<void> reveal(WidgetTester tester, Finder target) async {
  final scrollable = find
      .descendant(
          of: find.byType(ListView).last,
          matching: find.byWidgetPredicate((widget) =>
              widget is Scrollable &&
              widget.axisDirection == AxisDirection.down))
      .first;
  tester.state<ScrollableState>(scrollable).position.jumpTo(0);
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(target, 220, scrollable: scrollable);
  await tester.pumpAndSettle();
  await tester.ensureVisible(target);
}

class ArtworkFixture {
  ArtworkFixture(this.bytes);
  final Uint8List bytes;
  bool active = true, wrongScope = false;
  int downloads = 0;
  String? url;
  int status = 200;
  String contentType = 'image/png';
  Uint8List? responseBytes;
  Completer<void>? gate;
  late final row = <String, dynamic>{
    'id': artId,
    'workspace_id': 'workspace',
    'name': 'Forest scene',
    'type': 'illustration',
    'mime_type': 'image/png',
    'size_bytes': bytes.length,
    'status': 'approved',
    'created_by': 'author',
    'checksum': sha256.convert(bytes).toString(),
    'storage_path': artPath,
    'current_version_number': 2,
    'current_scan_status': 'clean',
    'requires_approval': true,
    'deleted_at': null
  };
  late final version = <String, dynamic>{
    'asset_id': artId,
    'version_number': 2,
    'storage_path': artPath,
    'mime_type': 'image/png',
    'size_bytes': bytes.length,
    'checksum': sha256.convert(bytes).toString(),
    'scan_status': 'clean'
  };
  late final api = ApiClient(
      baseUrl: 'https://api.example.test',
      token: 'synthetic',
      isCurrent: () => active,
      clientFactory: () => MockClient((request) async {
            expect(request.method, 'GET');
            if (request.url.path == '/v1/assets')
              return json({
                'assets': [
                  {...row, if (wrongScope) 'workspace_id': 'foreign'}
                ]
              });
            if (request.url.path.endsWith('/versions'))
              return json({
                'versions': [version]
              });
            expect(request.url.queryParameters['versionNumber'], '2');
            return json({
              'url': url ??
                  'https://storage.example.test/storage/v1/object/sign/book-assets/$artPath?token=synthetic-capability',
              'expiresIn': 300
            });
          }));
  late final loader = NativeArtwork(
      api: api,
      workspaceId: 'workspace',
      storageBaseUrl: 'https://storage.example.test/storage/v1',
      clientFactory: () => MockClient((request) async {
            downloads++;
            expect(request.headers.containsKey('authorization'), isFalse);
            expect(request.headers.containsKey('apikey'), isFalse);
            expect(request.followRedirects, isFalse);
            await gate?.future;
            return http.Response.bytes(responseBytes ?? bytes, status,
                headers: {'content-type': contentType});
          }));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Uint8List png;
  setUpAll(() async {
    final recorder = ui.PictureRecorder(), canvas = Canvas(recorder);
    canvas.drawRect(const Rect.fromLTWH(0, 0, 120, 90),
        Paint()..color = const Color(0xff192d28));
    canvas.drawCircle(
        const Offset(88, 23), 12, Paint()..color = const Color(0xffe9cb83));
    for (var x = 5; x < 120; x += 20) {
      canvas.drawPath(
          Path()
            ..moveTo(x.toDouble(), 85)
            ..lineTo(x + 14, 30)
            ..lineTo(x + 28, 85)
            ..close(),
          Paint()..color = const Color(0xff507364));
    }
    final picture = recorder.endRecording(),
        image = await picture.toImage(120, 90);
    png = (await image.toByteData(format: ui.ImageByteFormat.png))!
        .buffer
        .asUint8List();
    image.dispose();
    picture.dispose();
  });
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
      'table edits preserve unrelated metadata and synchronize canonical text and merge hashes',
      () {
    final original = grid();
    final merged =
        mergeTableCells(original, (row: 1, col: 0), (row: 2, col: 1));
    expect(merged['rows'], [
      ['Name', 'Place'],
      ['Fox\nForest\nOwl\nTree', ''],
      ['', '']
    ]);
    expect(tableSpans(merged), [(row: 1, col: 0, rowspan: 2, colspan: 2)]);
    final edited = editTableCell(merged, (row: 1, col: 0), '🌲 Both animals');
    expect(tableSpans(edited), tableSpans(merged));
    expect(edited['text'], tableText(manuscriptTableRows(edited)!));
    expect(edited['attributes']['tableSpanSource'],
        tableGridHash(manuscriptTableRows(edited)!));
    // Independently calculated by the existing TypeScript tableGridHash helper.
    expect(edited['attributes']['tableSpanSource'],
        'v2:68f2f8580e1c74abe7fde470db6ca55d4f50f33ba4a9675789bbd14ee193b92f');
    expect(edited['attributes']['importedStyle'],
        original['attributes']['importedStyle']);
    expect(edited['provenance'], 'retained');
    expect(original['rows'][1], ['Fox', 'Forest']);
    expect(splitTableCell(edited, (row: 1, col: 0))['rows'], edited['rows']);
    expect(tableSpans(splitTableCell(edited, (row: 1, col: 0))), isEmpty);
  });

  test(
      'table rejects header/body overlap, partial merge, covered edits and invalid bounds',
      () {
    expect(() => mergeTableCells(grid(), (row: 0, col: 0), (row: 1, col: 0)),
        throwsA(isA<ApiError>()));
    final merged = mergeTableCells(grid(), (row: 1, col: 0), (row: 2, col: 0));
    expect(() => editTableCell(merged, (row: 2, col: 0), 'hidden'),
        throwsA(isA<ApiError>()));
    expect(() => setTableHeaders(merged, 2), throwsA(isA<ApiError>()));
    expect(() => removeTableDimension(merged, 1, row: true),
        throwsA(isA<ApiError>()));
    expect(() => mergeTableCells(grid(), (row: -1, col: 0), (row: 2, col: 0)),
        throwsA(isA<ApiError>()));
    expect(() => editTableCell(grid(), (row: 0, col: 9), ''),
        throwsA(isA<ApiError>()));
    expect(() => editTableCell(grid(), (row: 1, col: 0), 'a' * 100001),
        throwsA(isA<ApiError>()));
    expect(() => setTableHeaders(grid(), 20), throwsA(isA<ApiError>()));
  });

  test('stale table spans and text cannot be silently flattened', () {
    final merged = mergeTableCells(grid(), (row: 1, col: 0), (row: 1, col: 1));
    final stale = {
      ...merged,
      'attributes': {
        ...merged['attributes'] as Map<String, dynamic>,
        'tableSpanSource': 'old'
      }
    };
    expect(staleTableLayout(stale), isTrue);
    expect(() => editTableCell(stale, (row: 1, col: 0), 'change'),
        throwsA(isA<ApiError>()));
    final reviewed = resetTableLayout(stale);
    expect(reviewed['rows'], stale['rows']);
    expect(tableSpans(reviewed), isEmpty);
    final mismatch = {...grid(), 'text': 'Newer text'};
    expect(manuscriptTableRows(mismatch), isNull);
    expect(() => resetTableLayout(mismatch), throwsA(isA<ApiError>()));
    final invalid = {
      ...grid(),
      'attributes': {
        'tableSpans': [
          {'row': 2, 'col': 0, 'rowspan': 99, 'colspan': 1}
        ],
        'tableSpanSource': tableGridHash(manuscriptTableRows(grid())!)
      }
    };
    expect(tableSpans(invalid), isEmpty);
  });

  test(
      'row and column operations retain merges and header membership with bounds',
      () {
    final merged = mergeTableCells(grid(), (row: 1, col: 0), (row: 1, col: 1));
    final removed = removeTableDimension(merged, 0, row: true);
    expect(tableHeaderRows(removed), 0);
    expect(tableSpans(removed), [(row: 0, col: 0, rowspan: 1, colspan: 2)]);
    expect(
        tableSpans(addTableDimension(removed, row: true)), tableSpans(removed));
    expect(manuscriptTableRows(addTableDimension(grid(), row: false))![0],
        ['Name', 'Place', '']);
    expect(manuscriptTableRows(removeTableDimension(grid(), 1, row: false))![0],
        ['Name']);
    expect(
        () => addTableDimension(grid(List.generate(2000, (_) => [''])),
            row: true),
        throwsA(isA<ApiError>()));
    expect(() => addTableDimension(grid([List.filled(100, '')]), row: false),
        throwsA(isA<ApiError>()));
    expect(manuscriptTableRows(addTableDimension(grid([]), row: true)), [
      ['']
    ]);
  });

  test(
      'artwork preview uses exact scanned bytes without forwarding authorization',
      () async {
    final fixture = ArtworkFixture(png);
    final available = await fixture.loader.available();
    expect(available, hasLength(1));
    final preview = await fixture.loader.preview(artId, 2);
    expect(preview.bytes, png);
    await fixture.loader.verifySelection(available.single, preview);
    expect(fixture.downloads, 1);
    fixture.row['current_version_number'] = 3;
    await expectLater(fixture.loader.verifySelection(available.single, preview),
        throwsA(isA<ApiError>()));
  });

  test(
      'artwork clearance rejects missing approval, dirty scans and malformed source identity',
      () async {
    for (final patch in [
      {'requires_approval': null},
      {'status': 'draft'},
      {'status': 'rejected'},
      {'status': 'archived'},
      {'deleted_at': '2026-01-01'},
      {'current_scan_status': 'pending'},
      {'current_scan_status': 'infected'},
      {'current_version_number': null},
      {'checksum': 'pending'},
      {'mime_type': 'text/plain'},
      {'size_bytes': 0}
    ]) {
      final fixture = ArtworkFixture(png);
      fixture.row.addAll(patch);
      expect(await fixture.loader.available(), isEmpty, reason: '$patch');
    }
    final plain = ArtworkFixture(png)
      ..row['requires_approval'] = false
      ..row['status'] = 'draft';
    expect(await plain.loader.available(), hasLength(1));
    final foreign = ArtworkFixture(png)..wrongScope = true;
    await expectLater(foreign.loader.available(), throwsA(isA<ApiError>()));
  });

  test(
      'private preview rejects foreign and ambiguous capabilities before download',
      () async {
    for (final url in [
      '/storage/v1/object/sign/book-assets/$artPath?token=a',
      'file:///storage/v1/object/sign/book-assets/$artPath?token=a',
      'data:image/png;base64,AA==',
      'https://foreign.test/storage/v1/object/sign/book-assets/$artPath?token=secret',
      'https://storage.example.test/storage/v1/object/sign/book-assets/$artPath?token=a&token=b',
      'https://storage.example.test/storage/v1/object/sign/book-assets/$artPath?token=a&redirect=b',
      'https://storage.example.test/storage/v1/object/sign/book-assets/$artPath?token=a#fragment',
      'https://user@storage.example.test/storage/v1/object/sign/book-assets/$artPath?token=a',
      'https://storage.example.test/storage/v1/object/sign/book-assets/foreign?token=a',
    ]) {
      final fixture = ArtworkFixture(png)..url = url;
      await expectLater(
          fixture.loader.preview(artId, 2), throwsA(isA<ApiError>()));
      expect(fixture.downloads, 0);
    }
  });

  test('preview rejects wrong scan, path, checksum, body, media and redirects',
      () async {
    for (final patch in [
      {'scan_status': 'infected'},
      {'checksum': 'pending'},
      {'storage_path': 'workspaces/foreign/assets/$artId/v2/forest.png'},
      {'size_bytes': maxArtworkPreviewBytes + 1},
      {'mime_type': 'image/svg+xml'},
      {'asset_id': 'foreign'},
      {'version_number': 3}
    ]) {
      final fixture = ArtworkFixture(png);
      fixture.version.addAll(patch);
      await expectLater(
          fixture.loader.preview(artId, 2), throwsA(isA<ApiError>()));
      expect(fixture.downloads, 0);
    }
    for (final status in [302, 403, 503]) {
      final fixture = ArtworkFixture(png)..status = status;
      await expectLater(
          fixture.loader.preview(artId, 2), throwsA(isA<ApiError>()));
    }
    final content = ArtworkFixture(png)..contentType = 'text/html';
    await expectLater(
        content.loader.preview(artId, 2), throwsA(isA<ApiError>()));
    final corrupt = ArtworkFixture(png)
      ..responseBytes = Uint8List.fromList([...png]..[0] = 0);
    await expectLater(
        corrupt.loader.preview(artId, 2), throwsA(isA<ApiError>()));
    final short = ArtworkFixture(png)..responseBytes = Uint8List(1);
    await expectLater(short.loader.preview(artId, 2), throwsA(isA<ApiError>()));
    final decode = ArtworkFixture(Uint8List.fromList([1, 2, 3, 4]));
    await expectLater(
        decode.loader.preview(artId, 2), throwsA(isA<ApiError>()));
  });

  test('late image response is discarded after account or workspace changes',
      () async {
    final fixture = ArtworkFixture(png)..gate = Completer<void>();
    final result = fixture.loader.preview(artId, 2);
    while (fixture.downloads == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    fixture.active = false;
    fixture.gate!.complete();
    await expectLater(
        result,
        throwsA(
            isA<ApiError>().having((e) => e.code, 'code', 'session_changed')));
  });

  testWidgets(
      'table cell edits, merge, undo, navigation and removal change only the manuscript draft',
      (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    var value = grid();
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        home: ManuscriptTableEditor(
            node: value,
            validateNode: (next) => document([next]),
            onChanged: (next) => value = next)));
    await tester.tap(find.text('Fox'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const ValueKey('table-cell-text')), 'Red fox');
    await tester.pumpAndSettle();
    expect(manuscriptTableRows(value)![1][0], 'Red fox');
    await tester.tap(find.byTooltip('Undo table change'));
    await tester.pumpAndSettle();
    expect(manuscriptTableRows(value)![1][0], 'Fox');
    await tester.tap(find.text('Fox'));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('Forest'));
    await tester.tap(find.text('Forest'));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('Merge selected'));
    await tester.tap(find.text('Merge selected'));
    await tester.pumpAndSettle();
    expect(tableSpans(value), [(row: 1, col: 0, rowspan: 1, colspan: 2)]);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'artwork insertion requires preview and description and retains exact pins',
      (tester) async {
    tester.view.physicalSize = const Size(390, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final fixture = ArtworkFixture(png);
    Map<String, dynamic>? inserted;
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        home: Builder(
            builder: (context) => Scaffold(
                body: TextButton(
                    onPressed: () async {
                      inserted = await Navigator.push(
                          context,
                          MaterialPageRoute(
                              builder: (_) => ManuscriptArtworkEditor(
                                  artwork: fixture.loader)));
                    },
                    child: const Text('Open picker'))))));
    await tester.tap(find.text('Open picker'));
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      await tester.tap(find.text('Forest scene'));
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(find.text('Pinned version 2'), findsOneWidget);
    await reveal(tester, find.text('Insert into draft'));
    await tester.tap(find.text('Insert into draft'));
    await tester.pumpAndSettle();
    expect(inserted, isNull);
    await reveal(
        tester, find.widgetWithText(TextField, 'Image description (alt text)'));
    await tester.enterText(
        find.widgetWithText(TextField, 'Image description (alt text)'),
        'A moon above a pine forest');
    await reveal(tester, find.text('Insert into draft'));
    await tester.tap(find.text('Insert into draft'));
    await tester.pumpAndSettle();
    expect(inserted?['assetId'], artId);
    expect(inserted?['assetVersionNumber'], 2);
    expect(inserted?['altText'], 'A moon above a pine forest');
    expect(tester.takeException(), isNull);
  });

  testWidgets('native manuscript table edits survive original-save reply loss',
      (tester) async {
    final fixture = ManuscriptFixture()..current = document([grid()]);
    final editor = fixture.editor();
    addTearDown(editor.dispose);
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        home: ManuscriptEditor(editor: editor, title: 'Moon Garden')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit table'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Fox'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const ValueKey('table-cell-text')), 'Golden fox');
    await tester.pumpAndSettle();
    expect(fixture.writes, isEmpty);
    await tester.pageBack();
    await tester.pumpAndSettle();
    fixture.lostReply = true;
    await tester.tap(find.byTooltip('Save manuscript'));
    await tester.pumpAndSettle();
    expect(fixture.writes, hasLength(1));
    expect(editor.operationId, isNotNull);
    await editor.recover();
    await tester.pumpAndSettle();
    expect(editor.operationId, isNull);
    expect(fixture.writes, hasLength(1));
    expect(
        manuscriptTableRows(fixture.current.nodes.single)![1][0], 'Golden fox');
  });
  mediaWidgetTests(() => png);
}

void mediaWidgetTests(Uint8List Function() imageBytes) {
  testWidgets(
      'read-only users navigate beyond the preview and read complete cell text',
      (tester) async {
    tester.view.physicalSize = const Size(320, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final fixture = ManuscriptFixture()
      ..role = 'viewer'
      ..current = document([
        grid(List.generate(23, (r) => ['Row $r complete contents', 'B$r']))
      ]);
    final editor = fixture.editor();
    addTearDown(editor.dispose);
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(1.6)),
            child: child!),
        home: ManuscriptEditor(editor: editor, title: 'Read the table')));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('View all table rows'));
    await tester.tap(find.text('View all table rows'));
    await tester.pumpAndSettle();
    expect(find.text('Add row'), findsNothing);
    await reveal(tester, find.widgetWithText(TextField, 'Go to row'));
    await tester.enterText(find.widgetWithText(TextField, 'Go to row'), '23');
    await tester.tap(find.text('Go'));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('Row 22 complete contents'));
    await tester.tap(find.text('Row 22 complete contents'));
    await tester.pumpAndSettle();
    await reveal(tester, find.byKey(const ValueKey('table-cell-text')));
    expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('table-cell-text')))
            .readOnly,
        isTrue);
    expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('table-cell-text')))
            .controller!
            .text,
        'Row 22 complete contents');
    expect(fixture.writes, isEmpty);
    expect(editor.dirty, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'table structural edits require removal confirmation and preserve undo',
      (tester) async {
    var value = grid();
    await tester.pumpWidget(MaterialApp(
        home: ManuscriptTableEditor(
            node: value,
            validateNode: (n) => document([n]),
            onChanged: (n) => value = n)));
    await tester.tap(find.text('Add row'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add column'));
    await tester.pumpAndSettle();
    expect(manuscriptTableRows(value)!.length, 4);
    expect(manuscriptTableRows(value)![0].length, 3);
    await tester.enterText(find.widgetWithText(TextField, 'Header rows'), '2');
    await tester.tap(find.text('Set headers'));
    await tester.pumpAndSettle();
    expect(tableHeaderRows(value), 2);
    await reveal(tester, find.text('Owl'));
    await tester.tap(find.text('Owl'));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('Remove selected row'));
    await tester.tap(find.text('Remove selected row'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(manuscriptTableRows(value)!.length, 4);
    await tester.tap(find.text('Remove selected row'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(manuscriptTableRows(value)!.length, 3);
    await tester.tap(find.byTooltip('Undo table change'));
    await tester.pumpAndSettle();
    expect(manuscriptTableRows(value)![2][0], 'Owl');
    await reveal(tester, find.text('Owl'));
    await tester.tap(find.text('Owl'));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('Remove selected column'));
    await tester.tap(find.text('Remove selected column'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(manuscriptTableRows(value)![0], ['Place', '']);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'stale table layout reset is reviewed and rejected cell edits retain accepted input',
      (tester) async {
    final merged = mergeTableCells(grid(), (row: 1, col: 0), (row: 1, col: 1));
    var value = {
      ...merged,
      'attributes': {
        ...merged['attributes'] as Map<String, dynamic>,
        'tableSpanSource': 'stale'
      }
    };
    await tester.pumpWidget(MaterialApp(
        home: ManuscriptTableEditor(
            node: value,
            validateNode: (n) {
              if (manuscriptTableRows(n)!.any((row) => row.contains('blocked')))
                throw manuscriptError('Synthetic document limit.');
              document([n]);
            },
            onChanged: (n) => value = n)));
    await tester.tap(find.text('Review as separate cells'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(staleTableLayout(value), isTrue);
    await tester.tap(find.text('Review as separate cells'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Use separate cells'));
    await tester.pumpAndSettle();
    expect(staleTableLayout(value), isFalse);
    expect(value['rows'], merged['rows']);
    await reveal(tester, find.text('Fox\nForest'));
    await tester.tap(find.text('Fox\nForest'));
    await tester.pumpAndSettle();
    await reveal(tester, find.byKey(const ValueKey('table-cell-text')));
    await tester.enterText(
        find.byKey(const ValueKey('table-cell-text')), 'blocked');
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('table-cell-text')))
            .controller!
            .text,
        'Fox\nForest');
    expect(manuscriptTableRows(value)![1][0], 'Fox\nForest');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'artwork settings preserve source and opaque metadata while applying print options',
      (tester) async {
    final fixture = ArtworkFixture(imageBytes());
    Map<String, dynamic>? changed;
    final node = <String, dynamic>{
      'id': 'art',
      'type': 'image',
      'assetId': artId,
      'assetVersionNumber': 2,
      'altText': 'Forest',
      'caption': 'Old caption',
      'attributes': {
        'importedCrop': {'x': 0.2}
      }
    };
    await tester.pumpWidget(MaterialApp(
        home: Builder(
            builder: (context) => Scaffold(
                body: TextButton(
                    onPressed: () async {
                      changed = await Navigator.push(
                          context,
                          MaterialPageRoute(
                              builder: (_) => ManuscriptArtworkEditor(
                                  artwork: fixture.loader, node: node)));
                    },
                    child: const Text('Settings'))))));
    await tester.tap(find.text('Settings'));
    await tester.pump();
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 80)));
    await tester.pumpAndSettle();
    await reveal(tester, find.widgetWithText(TextField, 'Caption'));
    await tester.enterText(
        find.widgetWithText(TextField, 'Caption'), 'Evening in the forest');
    await reveal(tester, find.text('Full-bleed print page'));
    await tester.tap(find.text('Full-bleed print page'));
    await tester.pumpAndSettle();
    await reveal(tester, find.text('Use artwork settings'));
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Use artwork settings'))
            .onPressed,
        isNotNull);
    await tester.tap(find.text('Use artwork settings'));
    await tester.pumpAndSettle();
    expect(changed?['assetId'], artId);
    expect(changed?['assetVersionNumber'], 2);
    expect(changed?['attributes']['importedCrop'], {'x': 0.2});
    expect(changed?['attributes']['printPlacement'], 'fullBleed');
    expect(changed?['caption'], 'Evening in the forest');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'artwork approval revocation blocks insertion without discarding the author form',
      (tester) async {
    final fixture = ArtworkFixture(imageBytes());
    await tester.pumpWidget(
        MaterialApp(home: ManuscriptArtworkEditor(artwork: fixture.loader)));
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      await tester.tap(find.text('Forest scene'));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pumpAndSettle();
    await reveal(tester, find.text('Purely decorative image'));
    await tester.tap(find.text('Purely decorative image'));
    await tester.pumpAndSettle();
    fixture.row['status'] = 'draft';
    await reveal(tester, find.text('Insert into draft'));
    await tester.tap(find.text('Insert into draft'));
    await tester.pumpAndSettle();
    await reveal(
        tester, find.textContaining('artwork or its approval changed'));
    expect(find.byType(ManuscriptArtworkEditor), findsOneWidget);
    expect(fixture.downloads, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'private image previews are explicit, refreshable and reset when the pin changes',
      (tester) async {
    final fixture = ArtworkFixture(imageBytes()),
        node = <String, dynamic>{
          'id': 'art',
          'type': 'image',
          'assetId': artId,
          'assetVersionNumber': 2,
          'altText': 'Forest'
        };
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: PrivateArtworkPreview(artwork: fixture.loader, node: node))));
    await tester.pumpAndSettle();
    expect(fixture.downloads, 0);
    await tester.runAsync(() async {
      await tester.tap(find.text('Preview pinned artwork'));
      await Future<void>.delayed(const Duration(milliseconds: 80));
    });
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsOneWidget);
    expect(fixture.downloads, 1);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: PrivateArtworkPreview(
                artwork: fixture.loader,
                node: {...node, 'assetVersionNumber': null}))));
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsNothing);
    await tester.tap(find.text('Preview pinned artwork'));
    await tester.pumpAndSettle();
    expect(find.textContaining('No exact artwork version'), findsOneWidget);
    expect(fixture.downloads, 1);
  });

  testWidgets(
      'artwork form navigation warns before discarding unapplied changes',
      (tester) async {
    final fixture = ArtworkFixture(imageBytes());
    await tester.pumpWidget(MaterialApp(
        home: Builder(
            builder: (context) => Scaffold(
                body: TextButton(
                    onPressed: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                            builder: (_) => ManuscriptArtworkEditor(
                                artwork: fixture.loader))),
                    child: const Text('Open'))))));
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await reveal(
        tester, find.widgetWithText(TextField, 'Image description (alt text)'));
    await tester.enterText(
        find.widgetWithText(TextField, 'Image description (alt text)'),
        'Unapplied description');
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep editing'));
    await tester.pumpAndSettle();
    expect(find.byType(ManuscriptArtworkEditor), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard form'));
    await tester.pumpAndSettle();
    expect(find.text('Open'), findsOneWidget);
    expect(fixture.downloads, 0);
  });

  testWidgets(
      'dark phone artwork surface renders with actual text and private image',
      (tester) async {
    tester.view.physicalSize = const Size(390, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const output = String.fromEnvironment('BOOKWORM_ARTWORK_SCREENSHOT'),
        fontPath = String.fromEnvironment('BOOKWORM_TEST_FONT_PATH');
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
    final fixture = ArtworkFixture(imageBytes()), boundary = GlobalKey();
    await tester.pumpWidget(RepaintBoundary(
        key: boundary,
        child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: bookwormTheme(),
            home: ManuscriptArtworkEditor(artwork: fixture.loader))));
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      await tester.tap(find.text('Forest scene'));
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(find.text('Pinned version 2'), findsOneWidget);
    expect(tester.takeException(), isNull);
    if (output.isNotEmpty)
      await tester.runAsync(() async {
        final rendered = boundary.currentContext!.findRenderObject()
                as RenderRepaintBoundary,
            image = await rendered.toImage(pixelRatio: 1);
        try {
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(output).writeAsBytes(bytes!.buffer.asUint8List());
        } finally {
          image.dispose();
        }
      });
  });
}
