import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';
import 'chapter_document.dart';
import 'models.dart';

enum ManuscriptPhase {
  loading,
  ready,
  saving,
  uncertain,
  conflict,
  unavailable
}

String newManuscriptId() {
  final random = Random.secure();
  return 'mobile-${List.generate(16, (_) => random.nextInt(256)).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';
}

/// Account-scoped drafts and save intents. Opening/recovering never writes remotely.
class ManuscriptDraft extends ChangeNotifier {
  ManuscriptDraft(
      {required this.api,
      required this.userId,
      required this.workspaceId,
      required this.bookId,
      required this.chapterId,
      this.storage = const FlutterSecureStorage()});
  final ApiClient api;
  final String userId, workspaceId, bookId, chapterId;
  final FlutterSecureStorage storage;
  List<String> get _scope =>
      [api.baseUrl, userId, workspaceId, bookId, chapterId];
  String get storageKey =>
      'bookworm:manuscript:${_scope.map(Uri.encodeComponent).join(':')}';

  ChapterDocument? base, draft, latest;
  String role = '', message = 'Loading manuscript…';
  String? operationId;
  ManuscriptPhase phase = ManuscriptPhase.loading;
  bool _busy = false, _disposed = false, durable = false;
  Future<void> _writes = Future.value();
  int _revision = 0;
  bool get busy => _busy;
  bool get dirty => draft != null && !sameJson(base?.nodes, draft!.nodes);
  bool get canEdit =>
      !_busy &&
      operationId == null &&
      manuscriptEditRoles.contains(role) &&
      draft != null;
  bool get canSave =>
      !_busy &&
      manuscriptEditRoles.contains(role) &&
      phase != ManuscriptPhase.conflict &&
      (dirty || operationId != null);

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _check() {
    api.ensureCurrent();
    if (_disposed)
      throw manuscriptError('This editor is closed. Reopen the chapter.');
  }

  ManuscriptPhase _restingPhase() => base == null
      ? ManuscriptPhase.unavailable
      : latest != null && latest!.version != base!.version
          ? ManuscriptPhase.conflict
          : operationId != null
              ? ManuscriptPhase.uncertain
              : ManuscriptPhase.ready;

  Future<void> _run(
      ManuscriptPhase working, Future<void> Function() action) async {
    if (_busy)
      return; // Double taps must not start another save or throw into UI.
    _busy = true;
    phase = working;
    _notify();
    try {
      _check();
      await action();
      _check();
    } on ApiError catch (error) {
      message = error.message;
    } on Exception {
      message =
          'The draft could not be accessed securely. Keep this editor open and try again.';
    } finally {
      _busy = false;
      phase = _restingPhase();
      _notify();
    }
  }

  Future<void> _persist() {
    _check();
    final revision = _revision;
    final value = base == null || (!dirty && operationId == null)
        ? null
        : jsonEncode({
            'schema': 1,
            'scope': _scope,
            'base': base!.toJson(),
            'nodes': draft!.nodes,
            'operationId': operationId,
          });
    final write = _writes.then((_) async {
      _check();
      if (value == null) {
        await storage.delete(key: storageKey);
      } else {
        await storage.write(key: storageKey, value: value);
      }
      _check();
      if (revision == _revision) durable = true;
    });
    // A failed write must not poison subsequent explicit retries.
    _writes = write.catchError((Object _) {});
    return write;
  }

  Future<void> keepDraft() => _run(ManuscriptPhase.saving, () async {
        await _persist();
        message = 'Draft kept securely on this device. It is not published.';
      });

  /// Debounced by the view; serialized with explicit saves, never a network write.
  Future<void> checkpointDraft() async {
    if (_busy || operationId != null || !dirty || durable || _disposed) return;
    final revision = _revision;
    try {
      await _persist();
      if (revision == _revision && !_busy)
        message = 'Draft kept securely on this device. Save to sync it online.';
    } on Exception {
      if (revision == _revision && !_busy)
        message =
            'Local draft could not be stored securely. Keep this editor open and retry.';
    }
    _notify();
  }

  void updateNodes(List<Map<String, dynamic>> nodes) {
    _check();
    if (!canEdit)
      throw manuscriptError(
          'Resolve the pending save or read-only access before editing.');
    draft = base!.withNodes(nodes);
    _revision++;
    durable = false;
    message = 'Unsaved changes. Save online or keep a draft on this device.';
    _notify();
  }

  Future<void> load() => _run(ManuscriptPhase.loading, () async {
        if (draft == null) {
          final raw = await storage.read(key: storageKey);
          _check();
          if (raw != null) {
            if (raw.length > 9000000)
              throw manuscriptError(
                  'The saved draft is too large. It has not been removed.');
            final saved = jsonDecode(raw);
            if (saved is! Map<String, dynamic> ||
                saved['schema'] != 1 ||
                !sameJson(saved['scope'], _scope) ||
                (saved['operationId'] != null &&
                    (saved['operationId'] is! String ||
                        !RegExp(r'^mobile-[a-f0-9]{32}$')
                            .hasMatch(saved['operationId'] as String)))) {
              throw manuscriptError(
                  'The saved draft cannot be verified. It has not been removed.');
            }
            final original = ChapterDocument.parse(saved['base'], chapterId);
            final restored = ChapterDocument.parse(
                {...original.toJson(), 'nodes': saved['nodes']}, chapterId);
            base = original;
            draft = restored;
            operationId = saved['operationId'] as String?;
            durable = true;
          }
        }
        final saved = await api.getChapterDocument(chapterId, bookId);
        _check();
        role = saved.role;
        latest = saved.document;
        if (base == null) {
          base = latest;
          draft = latest;
          durable = true;
        }
        if (operationId != null && await _recoverReceipt()) return;
        message = latest!.version != base!.version
            ? 'The saved chapter changed. Your draft is intact; compare or merge before saving.'
            : operationId != null
                ? 'The original save is unconfirmed. Check its status or retry the same save.'
                : dirty
                    ? 'Local draft restored. Review it before saving.'
                    : 'Saved version ${base!.version}';
      });

  Future<void> _accept(ChapterDocument saved) async {
    if (saved.version != base!.version + 1 ||
        !sameJson(saved.nodes, draft!.nodes)) {
      throw manuscriptError(
          'The save receipt does not match this draft. Keep the original request and check its status.');
    }
    // Clear only after verifying the exact original result. Failure retains intent.
    await _writes;
    _check();
    await storage.delete(key: storageKey);
    _check();
    base = saved;
    draft = saved;
    latest = saved;
    operationId = null;
    _revision++;
    durable = true;
    message = 'Saved version ${saved.version}';
  }

  Future<bool> _recoverReceipt() async {
    final id = operationId;
    if (id == null) return false;
    final saved = await api.getChapterSave(chapterId, id);
    _check();
    if (saved == null) return false;
    await _accept(saved);
    return true;
  }

  Future<void> recover() => _run(ManuscriptPhase.loading, () async {
        if (await _recoverReceipt()) return;
        final saved = await api.getChapterDocument(chapterId, bookId);
        _check();
        role = saved.role;
        latest = saved.document;
        message = latest!.version != base?.version
            ? 'The saved chapter changed. Your original draft and save request are preserved.'
            : 'No receipt found yet. Retry only the original save; it cannot create a duplicate version.';
      });

  Future<void> save() => _run(ManuscriptPhase.saving, () async {
        if (!manuscriptEditRoles.contains(role) || draft == null)
          throw manuscriptError('This chapter is read-only.');
        if (!dirty && operationId == null) {
          message = 'No changes to save.';
          return;
        }
        if (operationId != null && await _recoverReceipt()) return;
        if (latest != null && latest!.version != base!.version) {
          throw manuscriptError(
              'Review the changed saved chapter before saving. Your draft is intact.');
        }
        operationId ??= newManuscriptId();
        _revision++;
        durable = false;
        await _persist(); // No remote write is possible without durable retry identity.
        final saved = await api.saveChapterDocument(draft!, operationId!);
        _check();
        await _accept(saved);
      });

  /// Explicitly merge disjoint block edits; still requires a separate Save action.
  Future<void> mergeLatest(
          {Map<String, bool> localChoices = const {},
          bool? localOrder,
          int? reviewedVersion}) =>
      _run(ManuscriptPhase.loading, () async {
        if (await _recoverReceipt()) return;
        final saved = await api.getChapterDocument(chapterId, bookId);
        _check();
        role = saved.role;
        latest = saved.document;
        if (!manuscriptEditRoles.contains(role) ||
            base == null ||
            draft == null) throw manuscriptError('This chapter is read-only.');
        if (reviewedVersion != null && latest!.version != reviewedVersion) {
          throw manuscriptError(
              'The saved chapter changed again. Review the new version before resolving conflicts.');
        }
        if (operationId != null && latest!.version <= base!.version) {
          throw manuscriptError(
              'Resolve the original save before changing its draft.');
        }
        final merged = mergeManuscript(base!, draft!, latest!,
            localChoices: localChoices, localOrder: localOrder);
        final nextDraft = latest!.withNodes(merged);
        base = latest;
        draft = nextDraft;
        operationId = null;
        _revision++;
        durable = false;
        await _persist();
        message = 'Changes merged into your local draft. Review, then Save.';
      });

  /// UI must ask for confirmation, including the unconfirmed-save warning.
  Future<void> discardAndReload() => _run(ManuscriptPhase.loading, () async {
        final saved = await api.getChapterDocument(chapterId, bookId);
        _check();
        await _writes;
        await storage.delete(key: storageKey);
        _check();
        role = saved.role;
        base = saved.document;
        draft = base;
        latest = base;
        operationId = null;
        _revision++;
        durable = true;
        message = 'Loaded saved version ${base!.version}';
      });

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
