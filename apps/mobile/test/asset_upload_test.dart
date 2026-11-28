import 'dart:async';
import 'dart:convert';

import 'package:bookworm_mobile/api.dart';
import 'package:bookworm_mobile/asset_upload.dart';
import 'package:bookworm_mobile/models.dart';
import 'package:bookworm_mobile/auth.dart';
import 'package:bookworm_mobile/main.dart';
import 'package:bookworm_mobile/screens/assets_screen.dart';
import 'package:crypto/crypto.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart' hide AuthState;

const owner = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
final manuscript =
    Uint8List.fromList(utf8.encode('Private manuscript chosen by its author.'));
// Native XFile derives its name from path; the name argument is web-only.
XFile file([Uint8List? data]) =>
    XFile.fromData(data ?? manuscript, path: 'manuscript.txt');
http.Response json(Object data, [int status = 200]) =>
    http.Response(jsonEncode(data), status,
        headers: {'content-type': 'application/json'});

class Fixture {
  final records = <String, Map<String, dynamic>>{};
  final reservationIds = <String>[];
  bool current = true,
      loseReservation = false,
      loseTransfer = false,
      loseConfirmation = false;
  bool wrongDestination = false,
      scanUnavailable = false,
      switchAfterTransfer = false;
  int transferCalls = 0, confirmCalls = 0;
  Uint8List? stored;
  late final api = ApiClient(
      baseUrl: 'https://api.example.test',
      token: 'synthetic-access',
      isCurrent: () => current,
      clientFactory: () => MockClient(handleApi));
  Future<http.Response> handleApi(http.Request request) async {
    if (request.url.path == '/v1/workspaces')
      return json({
        'workspaces': [
          {
            'id': workspace,
            'name': 'My writing workspace',
            'organization_id': '33333333-3333-4333-8333-333333333333'
          }
        ]
      });
    if (request.method == 'GET')
      return json({'assets': records.values.toList()});
    final body = jsonDecode(request.body) as Map<String, dynamic>;
    if (request.url.path.endsWith('/upload-url')) {
      final id = body['requestId'] as String;
      reservationIds.add(id);
      final path = 'workspaces/$workspace/assets/$id/v1/${body['filename']}';
      records.putIfAbsent(
          id,
          () => {
                'id': id,
                'name': body['filename'],
                'workspace_id': workspace,
                'created_by': owner,
                'type': body['type'],
                'mime_type': body['mimeType'],
                'size_bytes': body['sizeBytes'],
                'status': 'draft',
                'checksum': 'pending',
                'storage_path': path,
                'current_version_number': 1,
                'current_scan_status': 'pending'
              });
      final record = records[id]!;
      if (record['current_scan_status'] == 'error')
        return json({'error': 'new reservation forbidden'}, 409);
      if (record['current_version_number'] == null) {
        record['current_version_number'] = 1;
        record['current_scan_status'] = 'pending';
      }
      if (loseReservation) {
        loseReservation = false;
        throw http.ClientException('synthetic lost reservation');
      }
      return json({
        'assetId': id,
        'path': path,
        'uploadUrl':
            'https://${wrongDestination ? 'foreign' : 'storage'}.example.test/storage/v1/object/upload/sign/book-assets/$path?token=synthetic-capability'
      });
    }
    if (request.url.path.endsWith('/confirm')) {
      confirmCalls++;
      final record = records[request.url.path.split('/')[3]]!;
      expect(body['checksumSha256'], sha256.convert(manuscript).toString());
      expect(body['sizeBytes'], manuscript.length);
      if (scanUnavailable) {
        record['current_scan_status'] = 'error';
        return json({'error': 'private scan output'}, 503);
      }
      record['checksum'] = body['checksumSha256'];
      record['current_scan_status'] = 'clean';
      if (loseConfirmation) {
        loseConfirmation = false;
        throw http.ClientException('synthetic lost confirmation');
      }
      return json({'confirmed': true, 'scanStatus': 'clean'});
    }
    throw StateError('Unexpected API request');
  }

  NativeAssetUpload uploader(
          {String userId = owner,
          http.Client Function()? transport,
          FlutterSecureStorage storage = const FlutterSecureStorage()}) =>
      NativeAssetUpload(
        api: api,
        userId: userId,
        workspaceId: workspace,
        storageBaseUrl: 'https://storage.example.test/storage/v1',
        storage: storage,
        uploadClientFactory: transport ?? storageTransport,
      );

  http.Client storageTransport() => MockClient((request) async {
        transferCalls++;
        expect(request.method, 'PUT');
        expect(request.followRedirects, isFalse);
        expect(request.headers.containsKey('authorization'), isFalse);
        expect(request.headers.containsKey('apikey'), isFalse);
        expect(request.headers['x-upsert'], isNot('true'));
        expect(request.url.host, 'storage.example.test');
        expect(request.url.queryParameters['token'], 'synthetic-capability');
        if (stored != null)
          return json({
            'statusCode': '409',
            'error': 'Duplicate',
            'message': 'Already exists'
          }, 409);
        // Exercise the real Storage SDK serialization, not a replacement upload helper.
        expect(
            utf8.decode(request.bodyBytes), contains(utf8.decode(manuscript)));
        stored = manuscript;
        if (switchAfterTransfer) current = false;
        if (loseTransfer) {
          loseTransfer = false;
          throw http.ClientException('synthetic lost transfer');
        }
        return json({'Key': request.url.path});
      });

  Future<AuthState> auth(WidgetTester tester) async {
    final client = (await tester.runAsync(() async => SupabaseClient(
        'https://storage.example.test', 'synthetic-public',
        authOptions: const AuthClientOptions(autoRefreshToken: false),
        httpClient: MockClient((_) async => json({})))))!;
    final claims = base64Url.encode(utf8.encode(jsonEncode({
      'exp': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600,
      'sub': owner
    })));
    await client.auth.recoverSession(jsonEncode({
      'access_token': 'eyJhbGciOiJub25lIn0.$claims.synthetic',
      'refresh_token': 'synthetic-refresh',
      'token_type': 'bearer',
      'expires_in': 3600,
      'user': {
        'id': owner,
        'aud': 'authenticated',
        'email': 'author@example.test',
        'app_metadata': {},
        'user_metadata': {},
        'created_at': '2026-01-01T00:00:00Z'
      },
    }));
    final state = AuthState(
        client: client,
        preferences: await SharedPreferences.getInstance(),
        apiBaseUrl: 'https://api.example.test',
        webBaseUrl: 'https://web.example.test',
        clientFactory: () => MockClient(handleApi));
    await state.refreshWorkspaces();
    addTearDown(() async {
      state.dispose();
      await tester.runAsync(client.dispose);
    });
    return state;
  }
}

class OversizedFile extends XFile {
  OversizedFile() : super('unused');
  @override
  String get name => 'large.pdf';
  @override
  Future<int> length() async => maxAssetUploadBytes + 1;
  @override
  Stream<Uint8List> openRead([int? start, int? end]) =>
      throw StateError('Oversized file must not be read');
}

class LockedStorage extends FlutterSecureStorage {
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
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    SharedPreferences.setMockInitialValues({});
  });

  test(
      'real selected bytes use scoped non-overwriting storage and verified clean confirmation',
      () async {
    final server = Fixture();
    final controller = server.uploader();
    await controller.load();
    await controller.upload(file(), type: 'manuscript');
    expect(server.transferCalls, 1);
    expect(server.confirmCalls, 1);
    expect(server.records.length, 1);
    expect(controller.pending, isNull);
    expect(await const FlutterSecureStorage().readAll(), isEmpty);
  });

  test(
      'lost reservation survives restart and reuses the same request with the original file',
      () async {
    final server = Fixture()..loseReservation = true;
    final first = server.uploader();
    await expectLater(
        first.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
    final id = first.pending!.id;
    final saved = (await const FlutterSecureStorage().readAll()).values.single;
    expect(saved, isNot(contains(utf8.decode(manuscript))));
    expect(saved, isNot(contains('synthetic-capability')));
    final other = server.uploader(userId: 'another-owner');
    await other.load();
    expect(other.pending, isNull);
    final resumed = server.uploader();
    await resumed.load();
    expect(resumed.pending!.id, id);
    await expectLater(
        resumed.upload(file(Uint8List.fromList('different content'.codeUnits)),
            type: 'manuscript'),
        throwsA(isA<ApiError>()));
    expect(server.reservationIds.length, 1);
    expect(server.transferCalls, 0);
    await resumed.upload(file(), type: 'manuscript');
    expect(server.reservationIds, [id, id]);
    expect(server.records.length, 1);
    expect(resumed.pending, isNull);
  });

  test(
      'lost transfer never overwrites an accepted object or creates another asset on retry',
      () async {
    final server = Fixture()..loseTransfer = true;
    final first = server.uploader();
    await expectLater(
        first.upload(file(), type: 'manuscript'), throwsA(isA<Exception>()));
    final retry = server.uploader();
    await retry.load();
    await retry.upload(file(), type: 'manuscript');
    expect(server.transferCalls, 2);
    expect(server.records.length, 1);
    expect(server.confirmCalls, 1);
    expect(server.reservationIds.toSet().length, 1);
    expect(retry.pending, isNull);
  });

  test('a fresh controller restores retry identity before starting any upload',
      () async {
    final server = Fixture()..loseReservation = true;
    final first = server.uploader();
    await expectLater(
        first.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
    final id = first.pending!.id;
    await server.uploader().upload(file(), type: 'manuscript');
    expect(server.reservationIds, [id, id]);
    expect(server.records.length, 1);
  });

  test(
      'scanner retry confirms the stored file without reserving or transferring it again',
      () async {
    final server = Fixture()..scanUnavailable = true;
    final first = server.uploader();
    await expectLater(
        first.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
    server.scanUnavailable = false;
    final resumed = server.uploader();
    await resumed.load();
    await resumed.upload(file(), type: 'manuscript');
    expect(server.reservationIds.length, 1);
    expect(server.transferCalls, 1);
    expect(server.confirmCalls, 2);
    expect(resumed.pending, isNull);
  });

  test(
      'status recovery after restart loads its saved record and never mutates the server',
      () async {
    final server = Fixture()..scanUnavailable = true;
    await expectLater(server.uploader().upload(file(), type: 'manuscript'),
        throwsA(isA<ApiError>()));
    server.records.values.single
      ..['checksum'] = sha256.convert(manuscript).toString()
      ..['current_scan_status'] = 'clean';
    expect(await server.uploader().recover(), isTrue);
    expect(server.reservationIds.length, 1);
    expect(server.transferCalls, 1);
    expect(server.confirmCalls, 1);
  });

  test(
      'lost confirmation recovers the verified original without repeating a mutation',
      () async {
    final server = Fixture()..loseConfirmation = true;
    final controller = server.uploader();
    await controller.upload(file(), type: 'manuscript');
    expect(server.confirmCalls, 1);
    expect(server.transferCalls, 1);
    expect(controller.pending, isNull);
  });

  test('scan failure stays pending and later clean recovery uses reads only',
      () async {
    final server = Fixture()..scanUnavailable = true;
    final controller = server.uploader();
    await expectLater(controller.upload(file(), type: 'manuscript'),
        throwsA(isA<ApiError>()));
    expect(controller.pending, isNotNull);
    expect(await controller.recover(), isFalse);
    final record = server.records.values.single;
    record['checksum'] = sha256.convert(manuscript).toString();
    record['current_scan_status'] = 'clean';
    expect(await controller.recover(), isTrue);
    expect(server.confirmCalls, 1);
    expect(server.transferCalls, 1);
  });

  test(
      'foreign upload destination and changed account cannot send or confirm private files',
      () async {
    final foreign = Fixture()..wrongDestination = true;
    await expectLater(foreign.uploader().upload(file(), type: 'manuscript'),
        throwsA(isA<ApiError>()));
    expect(foreign.transferCalls, 0);
    expect(foreign.confirmCalls, 0);
    FlutterSecureStorage.setMockInitialValues({});
    final switched = Fixture()..switchAfterTransfer = true;
    final upload = switched.uploader();
    await expectLater(
        upload.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
    expect(switched.confirmCalls, 0);
    expect(upload.pending, isNotNull);
    await expectLater(
        upload.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
    expect(switched.transferCalls, 1);
  });

  test(
      'unsupported, empty, oversized and non-image covers are refused before allocation',
      () async {
    final server = Fixture();
    final controller = server.uploader();
    for (final selected in [
      XFile.fromData(Uint8List(0), path: 'empty.txt'),
      XFile.fromData(manuscript, path: 'unsafe.exe'),
      OversizedFile()
    ]) {
      await expectLater(controller.upload(selected, type: 'source_document'),
          throwsA(isA<ApiError>()));
    }
    await expectLater(server.uploader().upload(file(), type: 'cover'),
        throwsA(isA<ApiError>()));
    expect(server.reservationIds, isEmpty);
    expect(await const FlutterSecureStorage().readAll(), isEmpty);
  });

  test(
      'storage redirects and oversized replies cannot become confirmed success',
      () async {
    for (final response in [
      http.Response('', 307, headers: {'location': 'https://foreign.test'}),
      http.Response('x' * 33000, 200)
    ]) {
      FlutterSecureStorage.setMockInitialValues({});
      final server = Fixture();
      final controller = server.uploader(
          transport: () => MockClient((request) async {
                expect(request.followRedirects, isFalse);
                return response;
              }));
      await expectLater(controller.upload(file(), type: 'manuscript'),
          throwsA(isA<ApiError>()));
      expect(server.confirmCalls, 0);
      expect(controller.pending, isNotNull);
    }
  });

  test('incomplete version allocation resumes the same request', () async {
    final server = Fixture()..loseReservation = true;
    final first = server.uploader();
    await expectLater(
        first.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
    final id = first.pending!.id;
    server.records[id]!
      ..['current_version_number'] = null
      ..['current_scan_status'] = null;
    await server.uploader().upload(file(), type: 'manuscript');
    expect(server.reservationIds, [id, id]);
    expect(server.records.length, 1);
    expect(server.transferCalls, 1);
  });

  test(
      'secure storage failure and unreadable recovery never start server mutations',
      () async {
    final server = Fixture();
    await expectLater(
        server
            .uploader(storage: LockedStorage())
            .upload(file(), type: 'manuscript'),
        throwsA(isA<PlatformException>()));
    final key = 'bookworm:upload:storage.example.test:$owner:$workspace';
    FlutterSecureStorage.setMockInitialValues({key: '{unreadable'});
    await expectLater(server.uploader().upload(file(), type: 'manuscript'),
        throwsA(isA<ApiError>()));
    expect(server.reservationIds, isEmpty);
    expect(server.transferCalls, 0);
    expect(await const FlutterSecureStorage().read(key: key), '{unreadable');
  });

  test('parallel status, discard and upload cannot race an in-flight transfer',
      () async {
    final server = Fixture(),
        started = Completer<void>(),
        response = Completer<http.Response>();
    final controller = server.uploader(
        transport: () => MockClient((_) {
              started.complete();
              return response.future;
            }));
    final uploading = controller.upload(file(), type: 'manuscript');
    await started.future;
    final id = controller.pending!.id;
    await expectLater(controller.recover(), throwsA(isA<ApiError>()));
    await expectLater(controller.forget(), throwsA(isA<ApiError>()));
    await expectLater(controller.upload(file(), type: 'manuscript'),
        throwsA(isA<ApiError>()));
    expect(controller.pending!.id, id);
    expect(server.reservationIds, [id]);
    response.complete(json({'Key': 'synthetic'}));
    await uploading;
    expect(server.confirmCalls, 1);
    expect(controller.pending, isNull);
  });

  test(
      'changed or quarantined saved assets are not silently replaced or accepted',
      () async {
    for (final change in [
      <String, dynamic>{'current_scan_status': 'infected'},
      {'created_by': 'foreign'},
      {'current_version_number': 2},
      {'checksum': '0' * 64}
    ]) {
      FlutterSecureStorage.setMockInitialValues({});
      final server = Fixture()..loseReservation = true;
      final first = server.uploader();
      await expectLater(
          first.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
      server.records.values.single.addAll(change);
      final retry = server.uploader();
      await expectLater(
          retry.upload(file(), type: 'manuscript'), throwsA(isA<ApiError>()));
      expect(retry.pending, isNotNull);
      expect(server.reservationIds.length, 1);
      expect(server.transferCalls, 0);
    }
  });

  Future<void> tapLabel(WidgetTester tester, String label) async {
    final target = find.text(label);
    if (target.evaluate().isEmpty) await tester.scrollUntilVisible(target, 120);
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    await tester.tap(target);
    await tester.pumpAndSettle();
  }

  testWidgets(
      'phone file flow requires confirmation, supports cancel and shows the verified file',
      (tester) async {
    final server = Fixture(), auth = await server.auth(tester);
    await tester.binding.setSurfaceSize(const Size(320, 568));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        home: MediaQuery(
            data: const MediaQueryData(
                size: Size(320, 568), textScaler: TextScaler.linear(1.6)),
            child: AssetsScreen(
                auth: auth,
                selectFile: () async => file(),
                storageClientFactory: server.storageTransport))));
    await tester.pumpAndSettle();
    await tapLabel(tester, 'Choose file and upload');
    expect(find.text('Upload this file?'), findsOneWidget);
    expect(server.reservationIds, isEmpty);
    expect(server.transferCalls, 0);
    await tapLabel(tester, 'Cancel');
    expect(server.reservationIds, isEmpty);
    await tapLabel(tester, 'Choose file and upload');
    await tester.runAsync(() async {
      await tester.tap(find.text('Upload file'));
      await tester.pumpAndSettle();
      // Hashing runs in a real isolate; widget fake time cannot advance it.
      for (var attempt = 0;
          attempt < 100 && server.confirmCalls == 0;
          attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    });
    await tester.pumpAndSettle();
    expect(server.transferCalls, 1,
        reason: tester
            .widgetList<Text>(find.byType(Text))
            .map((text) => text.data)
            .join(' | '));
    expect(server.confirmCalls, 1);
    expect(
        find.text(
            'Upload verified and screened. Your file is saved in Assets.'),
        findsOneWidget);
    await tester.scrollUntilVisible(find.text('manuscript.txt'), 180);
    expect(find.textContaining('Screening passed'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'reopened upload screen checks saved status without repeating transfer',
      (tester) async {
    final server = Fixture()..scanUnavailable = true;
    await tester.runAsync(() async {
      await expectLater(server.uploader().upload(file(), type: 'manuscript'),
          throwsA(isA<ApiError>()));
    });
    final auth = await server.auth(tester);
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        home: AssetsScreen(
            auth: auth,
            selectFile: () async =>
                throw StateError('Status must not open the picker'),
            storageClientFactory: server.storageTransport)));
    await tester.pumpAndSettle();
    expect(find.text('Saved upload: manuscript.txt'), findsOneWidget);
    await tapLabel(tester, 'Check saved upload');
    expect(find.textContaining('Upload is not confirmed yet.'), findsOneWidget);
    server.records.values.single
      ..['checksum'] = sha256.convert(manuscript).toString()
      ..['current_scan_status'] = 'clean';
    await tapLabel(tester, 'Check saved upload');
    expect(find.text('The original upload is verified and screened.'),
        findsOneWidget);
    expect(find.text('Resume original upload'), findsNothing);
    expect(server.transferCalls, 1);
    expect(server.confirmCalls, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'unreadable secure record blocks new uploads until explicit local discard',
      (tester) async {
    final key = 'bookworm:upload:storage.example.test:$owner:$workspace';
    FlutterSecureStorage.setMockInitialValues({key: '{unreadable'});
    final server = Fixture(), auth = await server.auth(tester);
    await tester.pumpWidget(
        MaterialApp(theme: bookwormTheme(), home: AssetsScreen(auth: auth)));
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Choose file and upload'))
            .onPressed,
        isNull);
    await tapLabel(tester, 'Discard local retry details');
    await tapLabel(tester, 'Keep details');
    expect(await const FlutterSecureStorage().read(key: key), '{unreadable');
    await tapLabel(tester, 'Discard local retry details');
    await tester.tap(find.widgetWithText(TextButton, 'Discard retry details'));
    await tester.pumpAndSettle();
    expect(await const FlutterSecureStorage().read(key: key), isNull);
    expect(server.reservationIds, isEmpty);
    expect(server.transferCalls, 0);
    expect(tester.takeException(), isNull);
  });
}
