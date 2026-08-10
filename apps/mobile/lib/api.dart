import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Thin client over the /v1 endpoints the screens use. All business rules stay
/// server-side; this only serializes requests and decodes the envelopes.
class ApiClient {
  ApiClient({required this.baseUrl, required this.token});

  final String baseUrl; // e.g. http://localhost:3001
  final String token; // Supabase access token (Bearer JWT)

  Map<String, String> get _headers => {
        'authorization': 'Bearer $token',
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
      {Map<String, dynamic>? body, Map<String, String?>? query}) async {
    final uri = _u(path, query);
    final req = http.Request(method, uri)..headers.addAll(_headers);
    if (body != null) req.body = jsonEncode(body);
    final res = await http.Response.fromStream(await req.send());
    final json = res.body.isEmpty
        ? <String, dynamic>{}
        : (jsonDecode(res.body) as Map).cast<String, dynamic>();
    if (res.statusCode >= 400) throw ApiError.fromJson(res.statusCode, json);
    return json;
  }

  Future<Map<String, dynamic>> _get(String path, [Map<String, String?>? q]) =>
      _req('GET', path, query: q);
  Future<Map<String, dynamic>> _post(String path, [Map<String, dynamic>? b]) =>
      _req('POST', path, body: b ?? const {});
  Future<Map<String, dynamic>> _patch(String path, Map<String, dynamic> b) =>
      _req('PATCH', path, body: b);

  Future<List<Workspace>> listWorkspaces() async => [
        for (final w in (await _get('/v1/workspaces'))['workspaces'] as List)
          Workspace.fromJson((w as Map).cast<String, dynamic>()),
      ];

  Future<List<Book>> listBooks(String workspaceId) async => [
        for (final b
            in (await _get('/v1/books', {'workspaceId': workspaceId}))['books']
                as List)
          Book.fromJson((b as Map).cast<String, dynamic>()),
      ];

  Future<List<Chapter>> listChapters(String bookId) async => [
        for (final c
            in (await _get('/v1/books/$bookId/chapters'))['chapters'] as List)
          Chapter.fromJson((c as Map).cast<String, dynamic>()),
      ];

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
      AiJob.fromJson(
          await ApiClient(baseUrl: aiBaseUrl, token: token)._get('/v1/ai/jobs/$jobId'));

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
  Future<List<AssetItem>> listAssets(String workspaceId) async => [
        for (final a
            in (await _get('/v1/assets', {'workspaceId': workspaceId}))['assets']
                as List)
          AssetItem.fromJson((a as Map).cast<String, dynamic>()),
      ];

  Future<Map<String, String>> createAssetUploadUrl(String workspaceId,
      {required String filename,
      required String mimeType,
      required int sizeBytes}) async {
    final j = await _post('/v1/assets/upload-url', {
      'workspaceId': workspaceId,
      'filename': filename,
      'mimeType': mimeType,
      'sizeBytes': sizeBytes,
    });
    return {
      'assetId': j['assetId'] as String,
      'uploadUrl': j['uploadUrl'] as String,
      'path': (j['path'] ?? j['storagePath'] ?? '') as String,
    };
  }

  Future<void> confirmAssetUpload(String assetId,
          {required String checksumSha256, required int sizeBytes}) =>
      _post('/v1/assets/$assetId/confirm',
          {'checksumSha256': checksumSha256, 'sizeBytes': sizeBytes});

  Future<List<TaskItem>> listTasks(String workspaceId, {String? status}) async => [
        for (final t in (await _get(
            '/v1/tasks', {'workspaceId': workspaceId, 'status': status}))['tasks'] as List)
          TaskItem.fromJson((t as Map).cast<String, dynamic>()),
      ];

  Future<void> createTask(String workspaceId, String title) =>
      _post('/v1/tasks', {'workspaceId': workspaceId, 'title': title});

  Future<void> updateTask(String taskId, {String? status}) =>
      _patch('/v1/tasks/$taskId', {if (status != null) 'status': status});

  Future<List<Map<String, dynamic>>> listComments(
      String workspaceId, String entityType, String entityId) async => [
        for (final c in (await _get('/v1/comments', {
          'workspaceId': workspaceId,
          'entityType': entityType,
          'entityId': entityId,
        }))['comments'] as List)
          (c as Map).cast<String, dynamic>(),
      ];

  Future<void> createComment(String workspaceId, String entityType,
          String entityId, String body) =>
      _post('/v1/comments', {
        'workspaceId': workspaceId,
        'entityType': entityType,
        'entityId': entityId,
        'body': body,
      });

  Future<List<Community>> listCommunities() async => [
        for (final c
            in (await _get('/v1/communities'))['communities'] as List)
          Community.fromJson((c as Map).cast<String, dynamic>()),
      ];

  Future<List<CommunityPost>> listCommunityPosts(String communityId) async => [
        for (final p
            in (await _get('/v1/communities/$communityId/posts'))['posts'] as List)
          CommunityPost.fromJson((p as Map).cast<String, dynamic>()),
      ];

  Future<void> createCommunityPost(String communityId,
          {String? title, required String body}) =>
      _post('/v1/communities/$communityId/posts',
          {if (title != null && title.isNotEmpty) 'title': title, 'body': body});

  Future<List<Map<String, dynamic>>> listPostComments(String postId) async => [
        for (final c in (await _get('/v1/posts/$postId/comments'))['comments']
            as List)
          (c as Map).cast<String, dynamic>(),
      ];

  Future<void> createPostComment(String postId, String body) =>
      _post('/v1/posts/$postId/comments', {'body': body});

  Future<Map<String, dynamic>> runPreflight(String bookId) =>
      _post('/v1/publishing/validate', {'bookId': bookId});

  Future<Map<String, dynamic>> createPublishingJob(String bookId,
          {required String channel, required String idempotencyKey}) =>
      _post('/v1/publishing/jobs',
          {'bookId': bookId, 'channel': channel, 'idempotencyKey': idempotencyKey});

  Future<UsageInfo> getUsage(String organizationId) async =>
      UsageInfo.fromJson(await _get('/v1/usage', {'organizationId': organizationId}));
}
