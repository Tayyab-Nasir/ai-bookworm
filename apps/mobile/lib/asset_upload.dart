import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import 'api.dart';
import 'models.dart';

const maxAssetUploadBytes = 100 * 1024 * 1024;
const assetMimeTypes = {
  'txt': 'text/plain',
  'md': 'text/markdown',
  'markdown': 'text/markdown',
  'pdf': 'application/pdf',
  'docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'epub': 'application/epub+zip',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'webp': 'image/webp',
  'gif': 'image/gif',
};
const assetKinds = ['source_document', 'manuscript', 'illustration', 'cover'];
final _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
String _digest(Uint8List bytes) => sha256.convert(bytes).toString();
String newRequestUuid() {
  final random = Random.secure();
  final bytes = List.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

String _safeFilename(String name) {
  final safe = name
      .replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_')
      .replaceFirst(RegExp(r'^\.+'), '_');
  return safe.substring(0, min(128, safe.length));
}

ApiError _uploadError(String message) =>
    ApiError(409, 'upload_unconfirmed', message, '');

/// Only a scoped retry record is persisted. Never store file bytes or signed URLs.
class PendingAssetUpload {
  const PendingAssetUpload(
      this.id, this.name, this.mime, this.size, this.checksum, this.type);
  final String id, name, mime, checksum, type;
  final int size;
  Map<String, Object> toJson() => {
        'id': id,
        'name': name,
        'mime': mime,
        'size': size,
        'checksum': checksum,
        'type': type
      };
  static PendingAssetUpload fromJson(Object? value) {
    if (value is! Map<String, dynamic> ||
        value['id'] is! String ||
        !_uuid.hasMatch(value['id']) ||
        value['name'] is! String ||
        (value['name'] as String).isEmpty ||
        (value['name'] as String).length > 256 ||
        (value['name'] as String).trim() != value['name'] ||
        RegExp(r'[\\/\x00-\x1f\x7f]').hasMatch(value['name']) ||
        assetMimeTypes[
                (value['name'] as String).split('.').last.toLowerCase()] !=
            value['mime'] ||
        !assetMimeTypes.values.contains(value['mime']) ||
        value['size'] is! int ||
        value['size'] < 1 ||
        value['size'] > maxAssetUploadBytes ||
        value['checksum'] is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(value['checksum']) ||
        !assetKinds.contains(value['type'])) {
      throw _uploadError(
          'Saved upload details are unreadable. Review Assets before discarding this retry record.');
    }
    return PendingAssetUpload(value['id'], value['name'], value['mime'],
        value['size'], value['checksum'], value['type']);
  }
}

class NativeAssetUpload {
  NativeAssetUpload(
      {required this.api,
      required this.workspaceId,
      required this.userId,
      required this.storageBaseUrl,
      this.storage = const FlutterSecureStorage(),
      http.Client Function()? uploadClientFactory})
      : _uploadClientFactory = uploadClientFactory ?? http.Client.new {
    final base = Uri.parse(storageBaseUrl);
    ApiClient.validateOrigin(base.origin);
    if (base.userInfo.isNotEmpty ||
        base.hasQuery ||
        base.hasFragment ||
        base.path != '/storage/v1') {
      throw const FormatException(
          'Configure the trusted Supabase Storage endpoint.');
    }
  }
  final ApiClient api;
  final String workspaceId, userId, storageBaseUrl;
  final FlutterSecureStorage storage;
  final http.Client Function() _uploadClientFactory;
  PendingAssetUpload? _pending;
  PendingAssetUpload? get pending => _pending;
  bool _busy = false;
  String get _key =>
      'bookworm:upload:${Uri.parse(storageBaseUrl).host}:$userId:$workspaceId';

  Future<T> _run<T>(Future<T> Function() operation) async {
    if (_busy) throw _uploadError('An upload operation is already running.');
    _busy = true;
    try {
      api.ensureCurrent();
      return await operation();
    } finally {
      _busy = false;
    }
  }

  Future<void> load() => _run(_load);

  Future<void> _load() async {
    api.ensureCurrent();
    final saved = await storage.read(key: _key);
    api.ensureCurrent();
    if (saved == null) {
      _pending = null;
      return;
    }
    try {
      _pending = PendingAssetUpload.fromJson(jsonDecode(saved));
    } on FormatException {
      throw _uploadError(
          'Saved upload details are unreadable. Review Assets before discarding this retry record.');
    }
  }

  Future<void> forget() => _run(() async {
        await storage.delete(key: _key);
        api.ensureCurrent();
        _pending = null;
      });

  Future<bool> recover() => _run(() async {
        await _load();
        return (await _readSaved())?.scanStatus == 'clean';
      });

  Future<AssetItem?> _readSaved() async {
    final draft = _pending;
    if (draft == null) return null;
    final assets = await api.listAssets(workspaceId);
    final matches = assets.where((asset) => asset.id == draft.id);
    if (matches.isEmpty) return null;
    if (matches.length != 1)
      throw _uploadError(
          'Saved upload status is unreadable. No file was changed.');
    final asset = matches.single;
    final path =
        'workspaces/$workspaceId/assets/${draft.id}/v1/${_safeFilename(draft.name)}';
    if (asset.createdBy != userId ||
        asset.workspaceId != workspaceId ||
        asset.name != draft.name ||
        asset.sizeBytes != draft.size ||
        asset.mimeType != draft.mime ||
        asset.type != draft.type ||
        asset.storagePath != path ||
        (asset.version != 1 && asset.version != null)) {
      throw _uploadError(
          'The saved asset changed. Review it in Assets before continuing.');
    }
    if (asset.version == 1 &&
        asset.checksum == draft.checksum &&
        asset.scanStatus == 'clean') {
      api.ensureCurrent();
      await storage.delete(key: _key);
      api.ensureCurrent();
      _pending = null;
      return asset;
    }
    // Allocation may have saved the asset but not its first version yet. Only
    // the same request may finish that allocation; terminal scan verdicts stop.
    final incompleteVersion = asset.version == null && asset.scanStatus == null;
    if (asset.status != 'draft' ||
        asset.checksum != 'pending' ||
        !(incompleteVersion ||
            asset.version == 1 &&
                ['pending', 'error'].contains(asset.scanStatus))) {
      throw _uploadError(
          'This upload is not cleared for use. Review its scan status in Assets.');
    }
    return asset;
  }

  Future<void> upload(XFile file, {required String type}) => _run(() async {
        // Always restore first: a caller must not accidentally replace a saved
        // request identity by forgetting to call load() after an app restart.
        await _load();
        final name = file.name.trim(),
            mime =
                assetMimeTypes[file.name.trim().split('.').last.toLowerCase()];
        final size = await file.length();
        if (name.isEmpty ||
            name.length > 256 ||
            RegExp(r'[\\/\x00-\x1f\x7f]').hasMatch(name) ||
            mime == null ||
            size < 1 ||
            size > maxAssetUploadBytes ||
            !assetKinds.contains(type) ||
            (['cover', 'illustration'].contains(type) &&
                !mime.startsWith('image/'))) {
          throw _uploadError(
              'Choose a supported non-empty document or image up to 100 MiB. Covers and illustrations must be images.');
        }
        final collected = BytesBuilder(copy: false);
        await for (final chunk in file.openRead()) {
          api.ensureCurrent();
          if (collected.length + chunk.length > maxAssetUploadBytes ||
              collected.length + chunk.length > size) {
            throw _uploadError(
                'The selected file changed or exceeds the upload limit.');
          }
          collected.add(chunk);
        }
        final bytes = collected.takeBytes();
        if (bytes.length != size)
          throw _uploadError('The selected file changed. Select it again.');
        final checksum = await compute(_digest, bytes);
        api.ensureCurrent();
        final old = _pending;
        if (old != null &&
            (old.name != name ||
                old.mime != mime ||
                old.size != size ||
                old.checksum != checksum ||
                old.type != type)) {
          throw _uploadError(
              'Select the original unchanged file to resume this upload.');
        }
        final draft = old ??
            PendingAssetUpload(
                newRequestUuid(), name, mime, size, checksum, type);
        // Save retry identity before any server mutation; failure here sends nothing.
        if (old == null) {
          await storage.write(key: _key, value: jsonEncode(draft.toJson()));
          _pending = draft;
        }
        api.ensureCurrent();
        final existing = await _readSaved();
        if (_pending == null) return;
        // A scanner error means the server already read the stored object. Re-run
        // confirmation with the original hash, never reserve or overwrite it.
        if (existing?.scanStatus != 'error') {
          final receipt = await api.createAssetUploadUrl(workspaceId,
              requestId: draft.id,
              filename: name,
              mimeType: mime,
              sizeBytes: size,
              type: type);
          final path =
              'workspaces/$workspaceId/assets/${draft.id}/v1/${_safeFilename(name)}';
          final url = Uri.tryParse(receipt['uploadUrl']!);
          final base = Uri.parse(storageBaseUrl);
          if (receipt['assetId'] != draft.id ||
              receipt['path'] != path ||
              url == null ||
              url.scheme != base.scheme ||
              url.host != base.host ||
              url.port != base.port ||
              url.userInfo.isNotEmpty ||
              url.hasFragment ||
              url.path != '${base.path}/object/upload/sign/book-assets/$path' ||
              url.queryParameters['token']?.isNotEmpty != true) {
            throw _uploadError(
                'The upload destination could not be verified. No file was sent.');
          }
          api.ensureCurrent();
          final transport = _ScopedUploadClient(_uploadClientFactory(), api);
          try {
            // The signed capability is sufficient; never forward a session or API key.
            final bucket = SupabaseStorageClient(storageBaseUrl, {},
                    httpClient: transport, retryAttempts: 0)
                .from('book-assets');
            try {
              await bucket
                  .uploadBinaryToSignedUrl(path, url.queryParameters['token']!,
                      bytes, FileOptions(contentType: mime, upsert: false), 0)
                  .timeout(const Duration(minutes: 2));
            } on StorageException catch (error) {
              // An earlier accepted transfer may have lost its reply. Do not overwrite it.
              if (error.statusCode != '409' && error.error != 'Duplicate')
                rethrow;
            }
          } finally {
            transport.close();
          }
        }
        api.ensureCurrent();
        try {
          await api.confirmAssetUpload(draft.id,
              checksumSha256: checksum, sizeBytes: size);
        } on ApiError {
          if ((await _readSaved())?.scanStatus == 'clean') return;
          rethrow;
        }
        if ((await _readSaved())?.scanStatus != 'clean')
          throw _uploadError(
              'Upload sent, but screening is not confirmed. Keep this retry record and check saved status.');
      });
}

class _ScopedUploadClient extends http.BaseClient {
  _ScopedUploadClient(this.client, this.api);
  final http.Client client;
  final ApiClient api;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    api.ensureCurrent();
    request.followRedirects = false;
    final response = await client.send(request);
    api.ensureCurrent();
    if (response.statusCode >= 300 && response.statusCode < 400)
      throw _uploadError(
          'Storage redirected the upload. Check saved status before retrying.');
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in response.stream) {
      api.ensureCurrent();
      if (bytes.length + chunk.length > 32 * 1024)
        throw _uploadError(
            'Storage returned an unreadable receipt. Check saved status.');
      bytes.add(chunk);
    }
    api.ensureCurrent();
    return http.StreamedResponse(
        Stream.value(bytes.takeBytes()), response.statusCode,
        headers: response.headers, request: request);
  }

  @override
  void close() => client.close();
}
