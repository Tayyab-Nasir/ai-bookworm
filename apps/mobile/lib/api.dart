import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'models.dart';
import 'chapter_document.dart';

/// Thin client over the /v1 endpoints the screens use. All business rules stay
/// server-side; this only serializes requests and decodes the envelopes.
class ApiClient {
  ApiClient(
      {required String baseUrl,
      required this.token,
      http.Client Function()? clientFactory,
      bool Function()? isCurrent,
      String Function()? accessToken,
      Duration timeout = const Duration(seconds: 20),
      bool allowLocalHttp = kDebugMode})
      : baseUrl = validateOrigin(baseUrl, allowLocalHttp: allowLocalHttp),
        _clientFactory = clientFactory ?? http.Client.new,
        _isCurrent = isCurrent,
        _accessToken = accessToken,
        _timeout = timeout;

  final String
      baseUrl; // The API origin, not the web app or a private AI service.
  final String token; // Supabase access token (Bearer JWT)
  final http.Client Function() _clientFactory;
  final bool Function()? _isCurrent;
  final String Function()? _accessToken;
  final Duration _timeout;

  static String validateOrigin(String value,
      {bool allowLocalHttp = kDebugMode}) {
    final uri = Uri.tryParse(value);
    if (uri == null ||
        value.trim() != value ||
        value.contains('\\') ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != '/') ||
        (uri.scheme != 'https' &&
            !(allowLocalHttp &&
                uri.scheme == 'http' &&
                ['localhost', '127.0.0.1', '[::1]', '::1', '10.0.2.2']
                    .contains(uri.host)))) {
      throw const FormatException('Configure a valid HTTPS service origin.');
    }
    return uri.origin;
  }

  void _checkSession() {
    if (_isCurrent?.call() == false) {
      throw ApiError(401, 'session_changed',
          'Your account or workspace changed. Reload saved data.', '');
    }
  }

  void ensureCurrent() => _checkSession();

  static ApiError _invalid() => ApiError(502, 'invalid_response',
      'The service returned an unreadable response. Try again.', '');

  static ApiError _failure(int status) => ApiError(
      status,
      'http_$status',
      switch (status) {
        401 => 'Your session expired. Sign in again.',
        403 => 'You do not have permission for this action.',
        404 => 'This item is unavailable or you no longer have access.',
        409 => 'This item changed. Reload it before trying again.',
        402 =>
          'This action requires available paid credits or an enabled plan.',
        429 => 'Too many requests. Wait before trying again.',
        _ =>
          'The request could not be completed. Reload saved data before retrying.',
      },
      '');

  Map<String, String> get _headers => {
        'authorization': 'Bearer ${_accessToken?.call() ?? token}',
        'content-type': 'application/json',
      };

  Uri _u(String path, [Map<String, String?>? query]) {
    final q = <String, String>{
      for (final e in (query ?? {}).entries)
        if (e.value != null && e.value!.isNotEmpty) e.key: e.value!,
    };
    return Uri.parse('$baseUrl$path')
        .replace(queryParameters: q.isEmpty ? null : q);
  }

  Future<Map<String, dynamic>> _req(String method, String path,
      {Map<String, dynamic>? body,
      Map<String, String?>? query,
      int responseLimit = 2 * 1024 * 1024}) async {
    _checkSession();
    final client = _clientFactory();
    try {
      return await (() async {
        _checkSession();
        final request = http.Request(method, _u(path, query))
          ..followRedirects = false
          ..headers.addAll(_headers);
        if (body != null) request.body = jsonEncode(body);
        final response = await client.send(request);
        _checkSession();
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw _failure(response.statusCode);
        }
        if (response.statusCode == 204) return <String, dynamic>{};
        if (response.headers['content-type']
                    ?.split(';')
                    .first
                    .trim()
                    .toLowerCase() !=
                'application/json' ||
            (response.contentLength ?? 0) > responseLimit) throw _invalid();
        final bytes = BytesBuilder(copy: false);
        await for (final chunk in response.stream) {
          _checkSession();
          if (bytes.length + chunk.length > responseLimit) throw _invalid();
          bytes.add(chunk);
        }
        _checkSession();
        final value = jsonDecode(utf8.decode(bytes.takeBytes()));
        if (value is! Map<String, dynamic>) throw _invalid();
        return value;
      })()
          .timeout(_timeout);
    } on TimeoutException {
      _checkSession();
      throw ApiError(504, 'timeout',
          'The request timed out. Check saved data before retrying.', '');
    } on FormatException {
      throw _invalid();
    } on http.ClientException {
      _checkSession();
      throw ApiError(503, 'network',
          'The service could not be reached. Check your connection.', '');
    } finally {
      client.close();
    }
  }

  Future<Map<String, dynamic>> _get(String path, [Map<String, String?>? q]) =>
      _req('GET', path, query: q);
  Future<Map<String, dynamic>> _post(String path, [Map<String, dynamic>? b]) =>
      _req('POST', path, body: b ?? const {});
  Future<Map<String, dynamic>> _patch(String path, Map<String, dynamic> b) =>
      _req('PATCH', path, body: b);

  Future<List<Workspace>> listWorkspaces() async {
    final items = (await _get('/v1/workspaces'))['workspaces'];
    if (items is! List) throw _invalid();
    final workspaces = <Workspace>[];
    for (final item in items) {
      if (item is! Map<String, dynamic> ||
          item['id'] is! String ||
          item['name'] is! String ||
          item['organization_id'] is! String ||
          (item['id'] as String).isEmpty ||
          (item['organization_id'] as String).isEmpty) throw _invalid();
      workspaces.add(Workspace.fromJson(item));
    }
    return List.unmodifiable(workspaces);
  }

  Future<void> createWorkspace(String name) =>
      _post('/v1/workspaces', {'name': name});

  Book _book(Object? row, String workspaceId, [String? bookId]) {
    if (row is! Map<String, dynamic> ||
        row['id'] is! String ||
        (row['id'] as String).isEmpty ||
        (bookId != null && row['id'] != bookId) ||
        row['workspace_id'] != workspaceId ||
        row['title'] is! String ||
        row['author_name'] is! String ||
        row['status'] is! String ||
        (row['subtitle'] != null && row['subtitle'] is! String) ||
        (row['genre'] != null && row['genre'] is! String) ||
        (row['language'] != null && row['language'] is! String) ||
        (row['created_by'] != null && row['created_by'] is! String))
      throw _invalid();
    return Book.fromJson(row);
  }

  Future<List<Book>> listBooks(String workspaceId) async {
    final rows =
        (await _get('/v1/books', {'workspaceId': workspaceId}))['books'];
    if (rows is! List) throw _invalid();
    final books = rows.map((row) => _book(row, workspaceId)).toList();
    if (books.map((b) => b.id).toSet().length != books.length) throw _invalid();
    return List.unmodifiable(books);
  }

  Future<({Book book, String role})> getBook(
      String bookId, String workspaceId) async {
    final result = await _get('/v1/books/${Uri.encodeComponent(bookId)}');
    if (result['role'] is! String) throw _invalid();
    return (
      book: _book(result['book'], workspaceId, bookId),
      role: result['role'] as String
    );
  }

  Future<Book> createBook(String workspaceId, String userId, String requestId,
      Map<String, String> details) async {
    final book = _book(
        await _post('/v1/books',
            {...details, 'workspaceId': workspaceId, 'requestId': requestId}),
        workspaceId,
        requestId);
    if (book.createdBy != userId) throw _invalid();
    return book;
  }

  Chapter _chapter(Object? row, String bookId) {
    if (row is! Map<String, dynamic> ||
        row['id'] is! String ||
        (row['id'] as String).isEmpty ||
        row['book_id'] != bookId ||
        row['title'] is! String ||
        row['status'] is! String ||
        row['order_index'] is! int ||
        row['order_index'] < 0) throw _invalid();
    return Chapter.fromJson(row);
  }

  Future<List<Chapter>> listChapters(String bookId) async {
    final rows = (await _get(
        '/v1/books/${Uri.encodeComponent(bookId)}/chapters'))['chapters'];
    if (rows is! List) throw _invalid();
    final chapters = rows.map((row) => _chapter(row, bookId)).toList();
    if (chapters.map((c) => c.id).toSet().length != chapters.length)
      throw _invalid();
    return List.unmodifiable(chapters);
  }

  Future<Chapter> createChapter(
          String bookId, String title, String requestId) async =>
      _chapter(
          (await _post('/v1/books/${Uri.encodeComponent(bookId)}/chapters',
              {'title': title, 'idempotencyKey': requestId}))['chapter'],
          bookId);

  ManuscriptImportJob _importJob(Object? row, String bookId,
      [String? assetId]) {
    if (row is! Map<String, dynamic> ||
        !_isUuid(row['id']) ||
        row['book_id'] != bookId ||
        !_isUuid(row['source_asset_id']) ||
        (assetId != null && row['source_asset_id'] != assetId) ||
        !['queued', 'running', 'succeeded', 'failed'].contains(row['status']) ||
        row['attempts'] is! int ||
        row['attempts'] < 0 ||
        row['attempts'] > 5 ||
        (row['error_code'] != null &&
            (row['error_code'] is! String ||
                !RegExp(r'^[a-z][a-z0-9_]{0,79}$')
                    .hasMatch(row['error_code'])))) throw _invalid();
    return ManuscriptImportJob(row['id'], bookId, row['source_asset_id'],
        row['status'], row['attempts'], row['error_code']);
  }

  static bool _isUuid(Object? value) =>
      value is String &&
      RegExp(r'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$',
              caseSensitive: false)
          .hasMatch(value);

  Future<List<ManuscriptImportJob>> listImportJobs(String bookId) async {
    final rows = (await _get(
        '/v1/books/${Uri.encodeComponent(bookId)}/import-jobs'))['jobs'];
    if (rows is! List || rows.length > 50) throw _invalid();
    final jobs = rows.map((row) => _importJob(row, bookId)).toList();
    if (jobs.map((j) => j.id).toSet().length != jobs.length ||
        jobs.map((j) => j.assetId).toSet().length != jobs.length)
      throw _invalid();
    return List.unmodifiable(jobs);
  }

  Future<ManuscriptImportJob> queueImport(
          String bookId, String assetId) async =>
      _importJob(
          (await _post('/v1/books/${Uri.encodeComponent(bookId)}/import-jobs',
              {'assetId': assetId}))['job'],
          bookId,
          assetId);

  Future<ManuscriptImportJob> retryImport(
      String bookId, ManuscriptImportJob job) async {
    final saved = _importJob(
        (await _post(
                '/v1/books/${Uri.encodeComponent(bookId)}/import-jobs/${Uri.encodeComponent(job.id)}/retry'))[
            'job'],
        bookId,
        job.assetId);
    if (saved.id != job.id) throw _invalid();
    return saved;
  }

  Future<ManuscriptImportReport?> getImportReport(
      String bookId, String assetId) async {
    final body = await _get(
        '/v1/books/${Uri.encodeComponent(bookId)}/imports/${Uri.encodeComponent(assetId)}');
    if (!body.containsKey('import')) throw _invalid();
    final result = body['import'];
    if (result == null) return null;
    if (result is! Map ||
        result['sourceAssetId'] != assetId ||
        result['chapters'] is! List ||
        result['assetIds'] is! List ||
        result['report'] is! Map) throw _invalid();
    final chapters = result['chapters'] as List,
        images = result['assetIds'] as List;
    final report = result['report'] as Map, warnings = report['warnings'];
    if (chapters.isEmpty ||
        chapters.length > 500 ||
        images.length > 100 ||
        !images.every(_isUuid) ||
        images.toSet().length != images.length ||
        warnings is! List ||
        warnings.length > 100 ||
        !warnings.every((w) => w is String && w.length <= 2000) ||
        report['chapterCount'] != chapters.length ||
        report['imageCount'] != images.length ||
        !chapters.every((c) =>
            c is Map &&
            _isUuid(c['id']) &&
            (c['book_id'] == null || c['book_id'] == bookId))) throw _invalid();
    final ids = chapters.map((c) => c['id'] as String).toList();
    if (ids.toSet().length != ids.length) throw _invalid();
    return ManuscriptImportReport(List.unmodifiable(ids), images.length,
        List<String>.unmodifiable(warnings));
  }

  Future<({ChapterDocument document, String role})> getChapterDocument(
      String chapterId, String bookId) async {
    final body = await _req(
        'GET', '/v1/chapters/${Uri.encodeComponent(chapterId)}/document',
        responseLimit: 5 * 1024 * 1024);
    final chapter = body['chapter'];
    if (chapter is! Map ||
        chapter['id'] != chapterId ||
        chapter['book_id'] != bookId ||
        body['role'] is! String) throw _invalid();
    return (
      document: ChapterDocument.parse(body['document'], chapterId),
      role: body['role'] as String
    );
  }

  Future<ChapterDocument> saveChapterDocument(
      ChapterDocument document, String operationId) async {
    final body = await _req('PUT',
        '/v1/chapters/${Uri.encodeComponent(document.chapterId)}/document',
        responseLimit: 5 * 1024 * 1024,
        body: {
          'expectedVersion': document.version,
          'nodes': document.nodes,
          'operationId': operationId,
          'changeSummary': 'Manuscript edited on mobile'
        });
    final saved = ChapterDocument.parse(body['document'], document.chapterId);
    if (body['version'] != saved.version ||
        body['versionId'] is! String ||
        (body['versionId'] as String).isEmpty) throw _invalid();
    return saved;
  }

  Future<ChapterDocument?> getChapterSave(
      String chapterId, String operationId) async {
    final body = await _req(
        'GET', '/v1/chapters/${Uri.encodeComponent(chapterId)}/saves',
        query: {'operationId': operationId}, responseLimit: 5 * 1024 * 1024);
    if (body['operationId'] != operationId) throw _invalid();
    if (body['status'] == 'not_found' && !body.containsKey('document'))
      return null;
    if (body['status'] != 'saved' ||
        body['versionId'] is! String ||
        (body['versionId'] as String).isEmpty) throw _invalid();
    return ChapterDocument.parse(body['document'], chapterId);
  }

  /// Apply a typed document operation. Returns the new version number.
  /// Throws ApiError(409) on stale expectedVersion — caller must reload.
  Future<int> applyChapterOperation(
    String chapterId, {
    required String operationId,
    required String type,
    required Map<String, dynamic> target,
    required Map<String, dynamic> payload,
    required int expectedVersion,
    String source = 'human',
    String? sourceRef,
  }) async =>
      (await _post('/v1/chapters/$chapterId/operations', {
        'operationId': operationId,
        'type': type,
        'target': target,
        'payload': payload,
        'source': source,
        if (sourceRef != null) 'sourceRef': sourceRef,
        'expectedVersion': expectedVersion,
      }))['version'] as int;

  // AI gateway: runs on its own base URL (services/ai), same bearer contract.
  Future<AiJob> createAiJob(String aiBaseUrl,
      {required String workspaceId,
      required String bookId,
      required String agentType,
      required String idempotencyKey,
      Map<String, dynamic> input = const {}}) async {
    final client = ApiClient(baseUrl: aiBaseUrl, token: token);
    final j = await client._post('/v1/ai/jobs', {
      'workspaceId': workspaceId,
      'bookId': bookId,
      'agentType': agentType,
      'input': input,
      'idempotencyKey': idempotencyKey,
    });
    return AiJob.fromJson(j);
  }

  Future<AiJob> getAiJob(String aiBaseUrl, String jobId) async =>
      AiJob.fromJson(await ApiClient(baseUrl: aiBaseUrl, token: token)
          ._get('/v1/ai/jobs/$jobId'));

  /// Marks the suggestion accepted and returns the validated operation for
  /// applyChapterOperation (the AI service never mutates documents itself).
  Future<Map<String, dynamic>> applyAiSuggestion(
      String aiBaseUrl, String suggestionId) async {
    final j = await ApiClient(baseUrl: aiBaseUrl, token: token)
        ._post('/v1/ai/suggestions/$suggestionId/apply');
    return (j['operation'] as Map).cast<String, dynamic>();
  }

  /// Signed upload flow: create upload-url -> upload bytes via
  /// SupabaseStorage.uploadToSignedUrl(path, token-from-url, bytes) ->
  /// confirmAssetUpload. A raw PUT does not satisfy Supabase signed upload
  /// URLs, so the upload step intentionally stays on the Supabase client.
  Future<List<AssetItem>> listAssets(String workspaceId) async {
    final rows =
        (await _get('/v1/assets', {'workspaceId': workspaceId}))['assets'];
    if (rows is! List) throw _invalid();
    return List.unmodifiable(rows.map((row) {
      if (row is! Map<String, dynamic> ||
          row['id'] is! String ||
          row['name'] is! String ||
          row['workspace_id'] != workspaceId ||
          row['type'] is! String ||
          row['mime_type'] is! String ||
          row['status'] is! String ||
          row['size_bytes'] is! int ||
          row['created_by'] is! String ||
          row['checksum'] is! String ||
          row['storage_path'] is! String ||
          (row['requires_approval'] != null &&
              row['requires_approval'] is! bool) ||
          (row['deleted_at'] != null && row['deleted_at'] is! String) ||
          (row['current_version_number'] != null &&
              row['current_version_number'] is! int) ||
          (row['current_scan_status'] != null &&
              row['current_scan_status'] is! String)) throw _invalid();
      return AssetItem.fromJson(row);
    }));
  }

  Future<List<Map<String, dynamic>>> listAssetVersions(String assetId) async {
    if (!_isUuid(assetId)) throw _invalid();
    final rows = (await _get(
        '/v1/assets/${Uri.encodeComponent(assetId)}/versions'))['versions'];
    if (rows is! List ||
        rows.any((row) =>
            row is! Map<String, dynamic> || row['asset_id'] != assetId))
      throw _invalid();
    return rows.cast<Map<String, dynamic>>();
  }

  Future<String> assetDownloadUrl(String assetId, int version) async {
    if (!_isUuid(assetId) || version < 1) throw _invalid();
    final value = await _get(
        '/v1/assets/${Uri.encodeComponent(assetId)}/download-url',
        {'versionNumber': '$version'});
    if (value['url'] is! String ||
        value['expiresIn'] is! int ||
        value['expiresIn'] < 1 ||
        value['expiresIn'] > 300) throw _invalid();
    return value['url'];
  }

  Future<Map<String, String>> createAssetUploadUrl(String workspaceId,
      {required String filename,
      required String mimeType,
      required int sizeBytes,
      required String requestId,
      required String type}) async {
    final j = await _post('/v1/assets/upload-url', {
      'workspaceId': workspaceId,
      'filename': filename,
      'mimeType': mimeType,
      'sizeBytes': sizeBytes,
      'requestId': requestId,
      'type': type,
    });
    if (j['assetId'] != requestId ||
        j['uploadUrl'] is! String ||
        j['path'] is! String) throw _invalid();
    return {
      'assetId': j['assetId'] as String,
      'uploadUrl': j['uploadUrl'] as String,
      'path': j['path'] as String,
    };
  }

  Future<void> confirmAssetUpload(String assetId,
          {required String checksumSha256, required int sizeBytes}) =>
      _post('/v1/assets/$assetId/confirm',
          {'checksumSha256': checksumSha256, 'sizeBytes': sizeBytes});

  Future<List<TaskItem>> listTasks(String workspaceId, {String? status}) async {
    final rows = (await _get(
        '/v1/tasks', {'workspaceId': workspaceId, 'status': status}))['tasks'];
    if (rows is! List) throw _invalid();
    return List.unmodifiable(rows.map((row) {
      if (row is! Map<String, dynamic> ||
          row['id'] is! String ||
          row['workspace_id'] != workspaceId ||
          row['title'] is! String ||
          row['status'] is! String ||
          row['priority'] is! String ||
          (row['description'] != null && row['description'] is! String) ||
          (row['due_at'] != null && row['due_at'] is! String)) throw _invalid();
      return TaskItem.fromJson(row);
    }));
  }

  Future<void> createTask(String workspaceId, String title) =>
      _post('/v1/tasks', {'workspaceId': workspaceId, 'title': title});

  Future<void> updateTask(String taskId, {String? status}) =>
      _patch('/v1/tasks/$taskId', {if (status != null) 'status': status});

  Future<List<Map<String, dynamic>>> listComments(
      String workspaceId, String entityType, String entityId) async {
    final rows = (await _get('/v1/comments', {
      'workspaceId': workspaceId,
      'entityType': entityType,
      'entityId': entityId,
    }))['comments'];
    if (rows is! List) throw _invalid();
    return List.unmodifiable(
        rows.map((row) => _comment(row, workspaceId, entityType, entityId)));
  }

  Map<String, dynamic> _comment(
      Object? row, String workspaceId, String entityType, String entityId) {
    if (row is! Map<String, dynamic> ||
        row['id'] is! String ||
        row['workspace_id'] != workspaceId ||
        row['entity_type'] != entityType ||
        row['entity_id'] != entityId ||
        row['author_id'] is! String ||
        row['body'] is! String) throw _invalid();
    return Map.unmodifiable(row);
  }

  Future<void> createComment(String workspaceId, String entityType,
      String entityId, String body) async {
    final saved = _comment(
        await _post('/v1/comments', {
          'workspaceId': workspaceId,
          'entityType': entityType,
          'entityId': entityId,
          'body': body,
        }),
        workspaceId,
        entityType,
        entityId);
    if (saved['body'] != body) throw _invalid();
  }

  Future<List<Community>> listCommunities() async => [
        for (final c in (await _get('/v1/communities'))['communities'] as List)
          Community.fromJson((c as Map).cast<String, dynamic>()),
      ];

  Future<List<CommunityPost>> listCommunityPosts(String communityId) async => [
        for (final p
            in (await _get('/v1/communities/$communityId/posts'))['posts']
                as List)
          CommunityPost.fromJson((p as Map).cast<String, dynamic>()),
      ];

  Future<void> createCommunityPost(String communityId,
          {String? title, required String body}) =>
      _post('/v1/communities/$communityId/posts', {
        if (title != null && title.isNotEmpty) 'title': title,
        'body': body
      });

  Future<List<Map<String, dynamic>>> listPostComments(String postId) async => [
        for (final c
            in (await _get('/v1/posts/$postId/comments'))['comments'] as List)
          (c as Map).cast<String, dynamic>(),
      ];

  Future<void> createPostComment(String postId, String body) =>
      _post('/v1/posts/$postId/comments', {'body': body});

  Future<Map<String, dynamic>> runPreflight(String bookId) =>
      _post('/v1/publishing/validate', {'bookId': bookId});

  Future<Map<String, dynamic>> createPublishingJob(String bookId,
          {required String channel, required String idempotencyKey}) =>
      _post('/v1/publishing/jobs', {
        'bookId': bookId,
        'channel': channel,
        'idempotencyKey': idempotencyKey
      });

  Future<UsageInfo> getUsage(String organizationId) async => UsageInfo.fromJson(
      await _get('/v1/usage', {'organizationId': organizationId}));
}
