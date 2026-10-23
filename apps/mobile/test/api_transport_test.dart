import 'dart:async';
import 'dart:convert';

import 'package:bookworm_mobile/api.dart';
import 'package:bookworm_mobile/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  ApiClient client(http.Client transport,
          {bool Function()? isCurrent,
          Duration timeout = const Duration(seconds: 1)}) =>
      ApiClient(
        baseUrl: 'https://api.example.test',
        token: 'synthetic-access',
        clientFactory: () => transport,
        isCurrent: isCurrent,
        timeout: timeout,
      );

  test('native requests target the API and never follow redirects', () async {
    final api = client(MockClient((request) async {
      expect(request.url.toString(), 'https://api.example.test/v1/workspaces');
      expect(request.headers['authorization'], 'Bearer synthetic-access');
      expect(request.followRedirects, isFalse);
      return http.Response('{"workspaces":[]}', 200,
          headers: {'content-type': 'application/json'});
    }));
    expect(await api.listWorkspaces(), isEmpty);
  });

  test('redirects, HTML, invalid JSON and wrong envelopes fail safely',
      () async {
    for (final response in [
      http.Response('private redirect', 302,
          headers: {'location': 'https://foreign.test'}),
      http.Response('<html>private upstream output</html>', 200),
      http.Response('{private', 200,
          headers: {'content-type': 'application/json'}),
      http.Response('[]', 200, headers: {'content-type': 'application/json'}),
      http.Response('{"workspaces":{}}', 200,
          headers: {'content-type': 'application/json'}),
    ]) {
      final api = client(MockClient((_) async => response));
      await expectLater(
          api.listWorkspaces(),
          throwsA(isA<ApiError>().having((error) => error.toString(),
              'safe error', isNot(contains('private')))));
    }
  });

  test('oversized and timed out responses do not become success', () async {
    final large = client(MockClient((_) async => http.Response(
        jsonEncode({'workspaces': [], 'padding': 'x' * 2100000}), 200,
        headers: {'content-type': 'application/json'})));
    await expectLater(large.listWorkspaces(), throwsA(isA<ApiError>()));
    final slow = client(MockClient((_) => Completer<http.Response>().future),
        timeout: const Duration(milliseconds: 5));
    await expectLater(
        slow.listWorkspaces(),
        throwsA(
            isA<ApiError>().having((error) => error.code, 'code', 'timeout')));
  });

  test(
      'chapter comments reject malformed and foreign replies without leaking them',
      () async {
    final valid = {
      'id': 'comment',
      'workspace_id': 'workspace',
      'entity_type': 'chapter',
      'entity_id': 'chapter',
      'author_id': 'author',
      'body': 'A note'
    };
    for (final rows in [
      null,
      {},
      ['private'],
      [
        {...valid, 'body': 3}
      ],
      [
        {...valid, 'workspace_id': 'foreign'}
      ],
      [
        {...valid, 'entity_id': 'foreign'}
      ]
    ]) {
      final api = client(MockClient((_) async => http.Response(
          jsonEncode({'comments': rows}), 200,
          headers: {'content-type': 'application/json'})));
      await expectLater(api.listComments('workspace', 'chapter', 'chapter'),
          throwsA(isA<ApiError>()));
    }
    final api = client(MockClient((request) async => http.Response(
        jsonEncode(request.method == 'GET'
            ? {
                'comments': [valid]
              }
            : valid),
        200,
        headers: {'content-type': 'application/json'})));
    expect((await api.listComments('workspace', 'chapter', 'chapter')).single,
        valid);
    await api.createComment('workspace', 'chapter', 'chapter', 'A note');
    final wrong = client(MockClient((_) async => http.Response('{}', 201,
        headers: {'content-type': 'application/json'})));
    await expectLater(
        wrong.createComment('workspace', 'chapter', 'chapter', 'A note'),
        throwsA(isA<ApiError>()));
  });

  test('a changed account blocks dispatch and discards an old reply', () async {
    var current = false;
    var calls = 0;
    final response = Completer<http.Response>();
    final api = client(MockClient((_) {
      calls++;
      return response.future;
    }), isCurrent: () => current);
    await expectLater(api.listWorkspaces(), throwsA(isA<ApiError>()));
    expect(calls, 0);
    current = true;
    final loading = api.listWorkspaces();
    await Future<void>.delayed(Duration.zero);
    current = false;
    response.complete(http.Response('{"workspaces":[]}', 200,
        headers: {'content-type': 'application/json'}));
    await expectLater(
        loading,
        throwsA(isA<ApiError>()
            .having((error) => error.code, 'code', 'session_changed')));
    expect(calls, 1);
  });

  test('API origins reject credentials, paths and insecure remote hosts', () {
    for (final origin in [
      'http://remote.test',
      'https://user:secret@api.test',
      'https://api.test/v1',
      'https://api.test?token=secret',
      'https://api.test#fragment',
      '//api.test',
      'file:///tmp/api'
    ]) {
      expect(() => ApiClient(baseUrl: origin, token: 'test'),
          throwsFormatException);
    }
    expect(ApiClient(baseUrl: 'http://127.0.0.1:3002', token: 'test'),
        isA<ApiClient>());
    expect(
        () => ApiClient(
            baseUrl: 'http://127.0.0.1:3002',
            token: 'test',
            allowLocalHttp: false),
        throwsFormatException);
  });

  test(
      'a scoped client uses refreshed credentials but never credentials from a changed account',
      () async {
    var token = 'synthetic-first', current = true;
    final sent = <String?>[];
    final api = ApiClient(
        baseUrl: 'https://api.example.test',
        token: token,
        accessToken: () => token,
        isCurrent: () => current,
        clientFactory: () => MockClient((request) async {
              sent.add(request.headers['authorization']);
              return http.Response('{"workspaces":[]}', 200,
                  headers: {'content-type': 'application/json'});
            }));
    await api.listWorkspaces();
    token = 'synthetic-refreshed';
    await api.listWorkspaces();
    current = false;
    token = 'synthetic-foreign';
    await expectLater(api.listWorkspaces(), throwsA(isA<ApiError>()));
    expect(sent, ['Bearer synthetic-first', 'Bearer synthetic-refreshed']);
  });
}
