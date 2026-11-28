import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';
import 'asset_upload.dart';
import 'chapter_document.dart';
import 'models.dart';

const manuscriptImportExtensions = ['txt', 'docx', 'epub', 'pdf'];
const maxManuscriptImportBytes = 20 * 1024 * 1024;

bool canImportAsset(AssetItem asset) =>
    manuscriptImportExtensions
        .contains(asset.name.split('.').last.toLowerCase()) &&
    asset.sizeBytes > 0 &&
    asset.sizeBytes <= maxManuscriptImportBytes &&
    asset.scanStatus == 'clean' &&
    asset.version != null &&
    asset.version! >= 1 &&
    RegExp(r'^[a-f0-9]{64}$').hasMatch(asset.checksum);

/// One durable, explicit author action per account/workspace/book. Restoring or
/// refreshing is read-only. Retries reuse the original server request identity.
class NativeBookWorkflow extends ChangeNotifier {
  NativeBookWorkflow(
      {required this.api,
      required this.userId,
      required this.workspaceId,
      this.bookId,
      this.storage = const FlutterSecureStorage()});
  final ApiClient api;
  final String userId, workspaceId;
  final String? bookId;
  final FlutterSecureStorage storage;
  List<String> get _scope =>
      [api.baseUrl, userId, workspaceId, bookId ?? 'new'];
  String get storageKey =>
      'bookworm:authoring:${_scope.map(Uri.encodeComponent).join(':')}';

  Book? book;
  String role = '', message = 'Loading saved book state…';
  List<Chapter> chapters = const [];
  List<ManuscriptImportJob> jobs = const [];
  final Map<String, ManuscriptImportReport> _reports = {};
  Map<String, ManuscriptImportReport> get reports => Map.unmodifiable(_reports);
  Map<String, dynamic>? _pending;
  String? get pendingKind => _pending?['kind'] as String?;
  String get pendingLabel => (_pending?['title'] ??
      _pending?['name'] ??
      (_pending?['details'] as Map?)?['title'] ??
      'Saved action') as String;
  Map<String, String>? get pendingDetails => pendingKind == 'book'
      ? Map<String, String>.from(_pending!['details'] as Map)
      : null;
  bool busy = false, loaded = false, _disposed = false;
  bool get canEdit => bookId != null && manuscriptEditRoles.contains(role);
  bool get canStart => loaded && !busy && _pending == null;

  void _check() {
    api.ensureCurrent();
    if (_disposed)
      throw manuscriptError('This book screen is closed. Reopen it.');
  }

  Future<void> _run(Future<void> Function() action) async {
    if (busy || _disposed) return;
    busy = true;
    notifyListeners();
    try {
      _check();
      await action();
      _check();
    } on ApiError catch (error) {
      message = error.message;
    } on Exception {
      message =
          'The action could not be confirmed. Keep your saved retry details and check saved status.';
    } finally {
      busy = false;
      if (!_disposed) notifyListeners();
    }
  }

  static Map<String, String> validateDetails(Map<String, String> input) {
    final limits = {
      'title': (1, 500),
      'authorName': (1, 300),
      'language': (2, 40),
      'subtitle': (0, 500),
      'genre': (0, 200)
    };
    if (input.keys.any((key) => !limits.containsKey(key))) {
      throw manuscriptError('Book details contain unsupported fields.');
    }
    final result = {...input, 'language': input['language'] ?? 'en'};
    for (final entry in limits.entries) {
      final value = (result[entry.key] ?? '').trim();
      if (value.length < entry.value.$1 || value.length > entry.value.$2) {
        throw manuscriptError(
            'Check title, author, language and optional detail lengths.');
      }
      if (entry.value.$1 > 0 || result.containsKey(entry.key))
        result[entry.key] = value;
    }
    return Map.unmodifiable(result);
  }

  Future<void> _restore() async {
    final raw = await storage.read(key: storageKey);
    _check();
    if (raw != null) {
      if (raw.length > 10000)
        throw manuscriptError(
            'Saved retry details are unreadable. They have not been removed.');
      final value = jsonDecode(raw);
      if (value is! Map<String, dynamic> ||
          value['schema'] != 1 ||
          !sameJson(value['scope'], _scope) ||
          value['pending'] is! Map<String, dynamic>) {
        throw manuscriptError(
            'Saved retry details belong to a different scope or are unreadable.');
      }
      final pending = value['pending'] as Map<String, dynamic>;
      bool id(Object? value) =>
          value is String &&
          RegExp(r'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')
              .hasMatch(value);
      if (pending['kind'] == 'book' &&
          bookId == null &&
          id(pending['id']) &&
          pending['details'] is Map &&
          (pending['details'] as Map).values.every((v) => v is String)) {
        validateDetails(Map<String, String>.from(pending['details'] as Map));
      } else if (pending['kind'] == 'chapter' &&
          bookId != null &&
          id(pending['id']) &&
          pending['title'] is String &&
          (pending['title'] as String).trim().isNotEmpty &&
          (pending['title'] as String).length <= 500) {
        // Exact title and request ID survive retries, including after rename.
      } else if (pending['kind'] == 'import' &&
          bookId != null &&
          id(pending['assetId']) &&
          pending['name'] is String &&
          (pending['name'] as String).length <= 256 &&
          pending['checksum'] is String &&
          RegExp(r'^[a-f0-9]{64}$').hasMatch(pending['checksum']) &&
          pending['size'] is int &&
          pending['size'] > 0 &&
          pending['size'] <= maxManuscriptImportBytes &&
          pending['version'] is int &&
          pending['version'] > 0) {
        // No file bytes, session tokens, capability URLs or parser payloads.
      } else {
        throw manuscriptError(
            'Saved retry details are unreadable. They have not been removed.');
      }
      _pending = Map.unmodifiable(pending);
    }
    loaded = true;
  }

  Future<void> _remember(Map<String, dynamic> value) async {
    _check();
    // Retain intent even if storage fails: never dispatch until it is durable.
    _pending = Map.unmodifiable(value);
    await storage.write(
        key: storageKey,
        value: jsonEncode({'schema': 1, 'scope': _scope, 'pending': value}));
    _check();
  }

  Future<void> _clearPending() async {
    _check();
    await storage.delete(key: storageKey);
    _check();
    _pending = null;
  }

  Future<void> refresh() => _run(() async {
        if (!loaded) await _restore();
        await _refresh();
      });

  Future<void> _refresh() async {
    if (bookId == null) {
      if (_pending == null) {
        message =
            'Create a private book, then write or import your manuscript.';
        return;
      }
      try {
        final saved = await api.getBook(_pending!['id'] as String, workspaceId);
        if (saved.book.createdBy != userId)
          throw manuscriptError(
              'This book request cannot be verified for your account.');
        book = saved.book;
        await _clearPending();
        message = 'Your original book is saved. Open it to write or import.';
      } on ApiError catch (error) {
        if (error.status != 404) rethrow;
        message =
            'Book creation is not confirmed. Resume the original request; do not start a duplicate.';
      }
      return;
    }
    final saved = await api.getBook(bookId!, workspaceId);
    _check();
    book = saved.book;
    role = saved.role;
    final chaptersFuture = api.listChapters(bookId!);
    final jobsFuture = api.listImportJobs(bookId!);
    final result = await Future.wait([chaptersFuture, jobsFuture]);
    _check();
    chapters = result[0] as List<Chapter>;
    jobs = result[1] as List<ManuscriptImportJob>;
    message = canEdit
        ? 'Your saved chapters are ready.'
        : 'Read-only access. An editor can add chapters or import.';
    if (pendingKind == 'chapter') {
      message =
          'Chapter creation is unconfirmed. Resume the same saved request to recover it without duplicating.';
    } else if (pendingKind == 'import') {
      await _readReport(_pending!['assetId'] as String);
    }
  }

  Future<void> _requireEditor() async {
    if (!loaded || bookId == null)
      throw manuscriptError('Reload saved book access first.');
    final saved = await api.getBook(bookId!, workspaceId);
    role = saved.role;
    if (!canEdit) throw manuscriptError('Your role cannot change this book.');
  }

  Future<void> create(Map<String, String> details) => _run(() async {
        if (!loaded || bookId != null || book != null)
          throw manuscriptError(
              'Reload your library before creating another book.');
        if (_pending != null)
          throw manuscriptError(
              'Resume or discard the saved request before changing its details.');
        await _remember({
          'kind': 'book',
          'id': newRequestUuid(),
          'details': validateDetails(details)
        });
        await _create();
      });
  Future<void> _create() async {
    await _remember(_pending!);
    final saved = await api.createBook(
        workspaceId,
        userId,
        _pending!['id'] as String,
        Map<String, String>.from(_pending!['details'] as Map));
    _check();
    book = saved;
    await _clearPending();
    message = 'Book created. Open it to write or import your manuscript.';
  }

  Future<void> addChapter(String title) => _run(() async {
        await _requireEditor();
        if (_pending != null)
          throw manuscriptError(
              'Resolve the saved action before adding another chapter.');
        if (title.trim().isEmpty || title.trim().length > 500)
          throw manuscriptError('Enter a chapter title up to 500 characters.');
        await _remember(
            {'kind': 'chapter', 'id': newRequestUuid(), 'title': title.trim()});
        await _createChapter();
      });
  Future<void> _createChapter() async {
    await _requireEditor();
    await _remember(_pending!);
    await api.createChapter(
        bookId!, _pending!['title'] as String, _pending!['id'] as String);
    _check();
    await _clearPending();
    await _refresh();
    message = 'Chapter saved. Open it to start writing.';
  }

  Future<AssetItem> _source(String assetId) async {
    final matches = (await api.listAssets(workspaceId))
        .where((a) => a.id == assetId)
        .toList();
    if (matches.length != 1 || !canImportAsset(matches.single)) {
      throw manuscriptError(
          'This source is not cleared for import. Check Files & artwork.');
    }
    return matches.single;
  }

  Future<void> importAsset(AssetItem selected) => _run(() async {
        await _requireEditor();
        if (_pending != null)
          throw manuscriptError(
              'Resolve the saved action before choosing another source.');
        final asset = await _source(selected.id);
        if (selected.workspaceId != workspaceId ||
            asset.checksum != selected.checksum ||
            asset.version != selected.version ||
            asset.sizeBytes != selected.sizeBytes) {
          throw manuscriptError(
              'This source changed. Select and review it again before importing.');
        }
        await _remember({
          'kind': 'import',
          'assetId': asset.id,
          'name': asset.name,
          'checksum': asset.checksum,
          'size': asset.sizeBytes,
          'version': asset.version
        });
        await _queue();
      });

  Future<void> _queue() async {
    await _requireEditor();
    final pending = _pending!;
    await _refresh(); // Lost queue reply may already have a job or receipt.
    if (_pending == null) return;
    if (jobs.any((j) => j.assetId == pending['assetId'])) return;
    final asset = await _source(pending['assetId'] as String);
    if (asset.checksum != pending['checksum'] ||
        asset.version != pending['version'] ||
        asset.sizeBytes != pending['size']) {
      throw manuscriptError(
          'The saved source changed. No replacement was queued. Review Files & artwork.');
    }
    await _remember(pending);
    await api.queueImport(bookId!, asset.id);
    _check();
    await _refresh();
  }

  Future<void> _readReport(String assetId) async {
    final report = await api.getImportReport(bookId!, assetId);
    _check();
    if (report != null) {
      _reports[assetId] = report;
      if (pendingKind == 'import' && _pending!['assetId'] == assetId)
        await _clearPending();
      message =
          'Import receipt verified: ${report.chapterIds.length} chapters, ${report.imageCount} images. Review formatting and warnings.';
      return;
    }
    final matches = jobs.where((j) => j.assetId == assetId);
    final job = matches.isEmpty ? null : matches.single;
    message = switch (job?.status) {
      'queued' ||
      'running' =>
        'Import ${job!.status}. Processing continues on the server if you leave. Refresh to check it.',
      'failed' =>
        'Import failed. Your original and existing chapters are preserved. Review the source before retrying.',
      'succeeded' =>
        'The job finished, but its saved import receipt is unavailable. Refresh; do not import another copy.',
      _ =>
        'Import acceptance is unconfirmed. Resume the same source request or check saved status.'
    };
  }

  Future<void> inspectImport(ManuscriptImportJob job) => _run(() async {
        await _refresh();
        await _readReport(job.assetId);
      });

  Future<void> retryImport(ManuscriptImportJob job) => _run(() async {
        await _requireEditor();
        await _refresh();
        final matches =
            jobs.where((j) => j.id == job.id && j.assetId == job.assetId);
        if (matches.isEmpty)
          throw manuscriptError('Refresh import history before retrying.');
        final current = matches.single;
        await _readReport(current.assetId);
        if (_reports.containsKey(current.assetId) || current.status != 'failed')
          return;
        // Explicit retry only; the server pins and rechecks the original checksum.
        await api.retryImport(bookId!, current);
        _check();
        await _refresh();
        message =
            'The original import was queued for another attempt. Refresh to check it.';
      });

  Future<void> resume() => _run(() async {
        if (!loaded || _pending == null)
          throw manuscriptError('No readable saved action is available.');
        switch (pendingKind) {
          case 'book':
            await _refresh();
            if (_pending != null) await _create();
          case 'chapter':
            await _createChapter();
          case 'import':
            await _queue();
        }
      });

  /// Local only. Caller must explain that this never cancels a server request.
  Future<void> discard() => _run(() async {
        await _clearPending();
        loaded = true;
        message =
            'Local retry details removed. No server book, chapter, file or job was deleted or cancelled.';
      });

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
