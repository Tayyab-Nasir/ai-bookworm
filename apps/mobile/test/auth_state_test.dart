import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart' hide AuthState;
import 'package:bookworm_mobile/auth.dart';
import 'package:bookworm_mobile/main.dart';
import 'package:bookworm_mobile/models.dart';
import 'package:bookworm_mobile/screens/auth_screen.dart';
import 'package:bookworm_mobile/secure_session.dart';

http.Response json(Object value, [int status = 200]) =>
    http.Response(jsonEncode(value), status,
        headers: {'content-type': 'application/json'});
Future<void> account(SupabaseClient client, String id) =>
    client.auth.recoverSession(jsonEncode({
      'access_token':
          '${base64Url.encode(utf8.encode('{"alg":"none"}'))}.${base64Url.encode(utf8.encode(jsonEncode({
            'exp': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600,
            'sub': id
          })))}.synthetic',
      'refresh_token': 'synthetic-refresh',
      'token_type': 'bearer',
      'expires_in': 3600,
      'user': {
        'id': id,
        'aud': 'authenticated',
        'email': '$id@example.test',
        'app_metadata': <String, dynamic>{},
        'user_metadata': <String, dynamic>{},
        'created_at': '2026-01-01T00:00:00Z'
      },
    }));
SupabaseClient supabase() =>
    SupabaseClient('https://auth.example.test', 'synthetic-public',
        authOptions: const AuthClientOptions(autoRefreshToken: false),
        httpClient: MockClient((_) async => json({})));
Map<String, String> workspace(String id) =>
    {'id': id, 'name': 'Workspace $id', 'organization_id': 'org-$id'};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test(
      'membership validation replaces stale preferences and clears empty or unavailable workspaces',
      () async {
    SharedPreferences.setMockInitialValues({
      'workspaceId': 'foreign',
      'workspaceName': 'Private cached name',
      'bookworm:workspace:alice': 'foreign'
    });
    final client = supabase();
    await account(client, 'alice');
    var response = json({
      'workspaces': [workspace('alice-work')]
    });
    final preferences = await SharedPreferences.getInstance();
    final auth = AuthState(
        client: client,
        preferences: preferences,
        apiBaseUrl: 'https://api.example.test',
        webBaseUrl: 'https://web.example.test',
        clientFactory: () => MockClient((_) async => response));
    addTearDown(() async {
      auth.dispose();
      await client.dispose();
    });
    expect(auth.workspace, isNull);
    await auth.refreshWorkspaces();
    expect(auth.workspace?.id, 'alice-work');
    expect(preferences.getString('bookworm:workspace:alice'), 'alice-work');
    await auth.selectWorkspace(Workspace('foreign', 'Foreign', 'foreign'));
    expect(auth.workspace?.id, 'alice-work');
    response = json({'workspaces': []});
    await auth.refreshWorkspaces();
    expect(auth.workspace, isNull);
    expect(auth.workspaces, isEmpty);
    expect(preferences.getString('bookworm:workspace:alice'), isNull);
    response = json({
      'workspaces': [workspace('alice-work')]
    });
    await auth.refreshWorkspaces();
    response = json({'private': 'must not surface'}, 503);
    await auth.refreshWorkspaces();
    expect(auth.workspace, isNull);
    expect(auth.workspaces, isEmpty);
    expect(auth.error, isNot(contains('private')));
    expect(auth.loading, isFalse);
  });

  test(
      'account switch rejects late private replies and prevents old clients dispatching',
      () async {
    final client = supabase();
    await account(client, 'alice');
    final held = Completer<http.Response>();
    var bookCalls = 0;
    final auth = AuthState(
        client: client,
        preferences: await SharedPreferences.getInstance(),
        apiBaseUrl: 'https://api.example.test',
        webBaseUrl: 'https://web.example.test',
        clientFactory: () => MockClient((request) async {
              if (request.url.path == '/v1/books') {
                bookCalls++;
                return held.future;
              }
              return json({
                'workspaces': [workspace(client.auth.currentUser!.id)]
              });
            }));
    var disposed = false;
    addTearDown(() async {
      if (!disposed) auth.dispose();
      await client.dispose();
    });
    await auth.start();
    await auth.refreshWorkspaces();
    final old = auth.api!;
    final reply = old.listBooks('alice');
    await Future<void>.delayed(Duration.zero);
    await account(client, 'bob');
    await auth.refreshWorkspaces();
    expect(auth.workspace?.id, 'bob');
    held.complete(json({'books': []}));
    await expectLater(
        reply,
        throwsA(
            isA<ApiError>().having((e) => e.code, 'code', 'session_changed')));
    await expectLater(old.listBooks('alice'), throwsA(isA<ApiError>()));
    expect(bookCalls, 1);
    auth.dispose();
    disposed = true;
    await account(client, 'charlie');
    expect(auth.workspace?.id, 'bob');
  });

  test('session and PKCE use separate secure namespaces, not preferences',
      () async {
    FlutterSecureStorage.setMockInitialValues({});
    const session = SecureSessionStorage('project-a'),
        other = SecureSessionStorage('project-b');
    const pkce = SecurePkceStorage('project-a');
    await session.initialize();
    await session.persistSession('synthetic-session');
    await pkce.setItem(key: 'verifier', value: 'synthetic-verifier');
    expect(await session.accessToken(), 'synthetic-session');
    expect(await other.accessToken(), isNull);
    expect(await pkce.getItem(key: 'verifier'), 'synthetic-verifier');
    expect((await SharedPreferences.getInstance()).getKeys(), isEmpty);
    await session.removePersistedSession();
    expect(await session.hasAccessToken(), isFalse);
    await pkce.removeItem(key: 'verifier');
    expect(await pkce.getItem(key: 'verifier'), isNull);
  });

  test(
      'OAuth callbacks require the exact native destination and PKCE query flow',
      () {
    expect(
        isMobileAuthCallback(Uri.parse('$mobileAuthRedirect?code=synthetic')),
        isTrue);
    for (final url in [
      'https://foreign.test?code=x',
      'com.bookworm.ai://other?code=x',
      'com.bookworm.ai://user@login-callback?code=x',
      '$mobileAuthRedirect/extra?code=x',
      '$mobileAuthRedirect#access_token=not-accepted'
    ]) {
      expect(isMobileAuthCallback(Uri.parse(url)), isFalse);
    }
  });

  test(
      'startup rejects privileged keys and removes only obsolete app authentication cache',
      () async {
    String jwt(String role) =>
        'header.${base64Url.encode(utf8.encode(jsonEncode({
              'role': role
            })))}.signature';
    expect(isPublicSupabaseKey('sb_publishable_synthetic'), isTrue);
    expect(isPublicSupabaseKey(jwt('anon')), isTrue);
    for (final key in [
      '',
      'sb_secret_synthetic',
      jwt('service_role'),
      jwt('authenticated'),
      'not.a.jwt'
    ]) {
      expect(isPublicSupabaseKey(key), isFalse);
    }
    SharedPreferences.setMockInitialValues({
      'access_token': 'obsolete',
      'workspaceName': 'private',
      'sb-project-a-auth-token': 'obsolete',
      'supabase.auth.token-code-verifier': 'obsolete',
      'sb-project-b-auth-token': 'unrelated',
      'bookworm:workspace:alice': 'workspace-a',
      'theme': 'dark'
    });
    final preferences = await SharedPreferences.getInstance();
    await clearLegacyAuthCache(preferences, 'https://project-a.supabase.co');
    expect(preferences.getKeys(),
        {'sb-project-b-auth-token', 'bookworm:workspace:alice', 'theme'});
  });

  testWidgets(
      'sign-in remains usable at phone width with keyboard and enlarged text',
      (tester) async {
    final client = (await tester.runAsync(() async => supabase()))!;
    final auth = AuthState(
        client: client,
        preferences: await SharedPreferences.getInstance(),
        apiBaseUrl: 'https://api.example.test',
        webBaseUrl: 'https://web.example.test');
    // Supabase owns a JSON isolate; create and close it outside fake widget time.
    addTearDown(() async {
      auth.dispose();
      await tester.runAsync(client.dispose);
    });
    await tester.binding.setSurfaceSize(const Size(320, 568));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
        theme: bookwormTheme(),
        home: MediaQuery(
            data: const MediaQueryData(
                size: Size(320, 568),
                viewInsets: EdgeInsets.only(bottom: 240),
                textScaler: TextScaler.linear(1.5)),
            child: AuthScreen(auth: auth))));
    expect(find.text('Continue with Google'), findsOneWidget);
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pump();
    expect(find.text('Enter a valid email address.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('account changes remove every previous private navigation route',
      (tester) async {
    final client = (await tester.runAsync(() async => supabase()))!;
    await account(client, 'alice');
    final auth = AuthState(
        client: client,
        preferences: await SharedPreferences.getInstance(),
        apiBaseUrl: 'https://api.example.test',
        webBaseUrl: 'https://web.example.test',
        clientFactory: () =>
            MockClient((request) async => json(switch (request.url.path) {
                  '/v1/workspaces' => {
                      'workspaces': client.auth.currentUser!.id == 'alice'
                          ? [workspace('alice')]
                          : []
                    },
                  '/v1/books' => {'books': []},
                  '/v1/assets' => {'assets': []},
                  '/v1/tasks' => {'tasks': []},
                  _ => {},
                })));
    addTearDown(() async {
      auth.dispose();
      await tester.runAsync(client.dispose);
    });
    await auth.refreshWorkspaces();
    await tester.pumpWidget(BookwormApp(auth: auth));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Files & artwork'));
    await tester.pumpAndSettle();
    expect(find.text('Files & artwork'), findsOneWidget);
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(navigator.push(MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('Alice private route')))));
    await tester.pumpAndSettle();
    expect(find.text('Alice private route'), findsOneWidget);
    await account(client, 'bob');
    await auth.refreshWorkspaces();
    await tester.pumpAndSettle();
    expect(find.text('Alice private route'), findsNothing);
    expect(find.text('Create workspace'), findsOneWidget);
  });
}
