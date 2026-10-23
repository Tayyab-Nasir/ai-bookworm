import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'chapter_document.dart';
import 'models.dart';

const artworkMimeTypes = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'};
const maxArtworkPreviewBytes = 20 * 1024 * 1024;
final _checksum = RegExp(r'^[a-f0-9]{64}$', caseSensitive: false);
final _assetId = RegExp(
    r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
    caseSensitive: false);

bool artworkPlaceable(AssetItem asset) =>
    _assetId.hasMatch(asset.id) &&
    asset.deletedAt == null &&
    artworkMimeTypes.contains(asset.mimeType) &&
    _checksum.hasMatch(asset.checksum) &&
    asset.version != null &&
    asset.version! > 0 &&
    asset.sizeBytes > 0 &&
    {'clean', 'trusted_generated'}.contains(asset.scanStatus) &&
    !{'archived', 'rejected'}.contains(asset.status) &&
    asset.requiresApproval != null &&
    (!asset.requiresApproval! || asset.status == 'approved');

String _identity(AssetItem asset) => jsonEncode([
      asset.id,
      asset.workspaceId,
      asset.version,
      asset.checksum,
      asset.storagePath,
      asset.mimeType,
      asset.sizeBytes,
      asset.requiresApproval,
      asset.status,
      asset.scanStatus
    ]);

class ArtworkPreview {
  const ArtworkPreview(this.bytes, this.version, this.checksum);
  final Uint8List bytes;
  final int version;
  final String checksum;
}

/// Private capabilities stay in memory. No bearer token is sent to Storage.
class NativeArtwork {
  NativeArtwork(
      {required this.api,
      required this.workspaceId,
      required this.storageBaseUrl,
      http.Client Function()? clientFactory,
      this.timeout = const Duration(seconds: 20)})
      : _clientFactory = clientFactory ?? http.Client.new {
    final uri = Uri.tryParse(storageBaseUrl);
    if (uri == null ||
        !uri.hasAuthority ||
        !{'https', 'http'}.contains(uri.scheme) ||
        uri.path != '/storage/v1' ||
        uri.hasQuery ||
        uri.hasFragment ||
        uri.userInfo.isNotEmpty) {
      throw const FormatException(
          'Configure the trusted Supabase Storage endpoint.');
    }
    ApiClient.validateOrigin(uri.origin);
  }
  final ApiClient api;
  final String workspaceId, storageBaseUrl;
  final http.Client Function() _clientFactory;
  final Duration timeout;

  Future<List<AssetItem>> available() async =>
      (await api.listAssets(workspaceId)).where(artworkPlaceable).toList();

  Future<void> verifySelection(
      AssetItem selected, ArtworkPreview preview) async {
    api.ensureCurrent();
    final current = (await available())
        .where((asset) => asset.id == selected.id)
        .firstOrNull;
    if (current == null ||
        _identity(current) != _identity(selected) ||
        preview.version != selected.version ||
        preview.checksum.toLowerCase() != selected.checksum.toLowerCase()) {
      throw manuscriptError(
          'This artwork or its approval changed. Refresh and review the current version before inserting.');
    }
  }

  Future<ArtworkPreview> preview(String assetId, int version) async {
    if (!_assetId.hasMatch(assetId) || version < 1)
      throw manuscriptError(
          'This artwork has no exact version pin. Select a reviewed version first.');
    // A caller cannot use this loader to preview a different workspace's asset.
    final assets = await api.listAssets(workspaceId);
    final asset =
        assets.where((a) => a.id == assetId && a.deletedAt == null).firstOrNull;
    if (asset == null)
      throw manuscriptError(
          'This artwork is unavailable in the current workspace.');
    final matches = (await api.listAssetVersions(assetId))
        .where((row) => row['version_number'] == version)
        .toList();
    if (matches.length != 1)
      throw manuscriptError('The pinned artwork version is unavailable.');
    final pinned = matches.single,
        size = pinned['size_bytes'],
        checksum = pinned['checksum'],
        path = pinned['storage_path'],
        mime = pinned['mime_type'];
    if (size is! int ||
        size < 1 ||
        checksum is! String ||
        !_checksum.hasMatch(checksum) ||
        path is! String ||
        !artworkMimeTypes.contains(mime) ||
        !{'clean', 'trusted_generated'}.contains(pinned['scan_status'])) {
      throw manuscriptError(
          'The pinned artwork is not confirmed and cleared for preview.');
    }
    if (size > maxArtworkPreviewBytes)
      throw manuscriptError(
          'Native artwork previews support files up to 20 MiB. The original file is preserved.');
    final prefix = 'workspaces/$workspaceId/assets/$assetId/v$version/';
    if (!path.startsWith(prefix) ||
        path.substring(prefix.length).isEmpty ||
        path.substring(prefix.length).contains('/') ||
        path.contains('\\') ||
        path.split('/').any((part) => {'.', '..'}.contains(part))) {
      throw manuscriptError(
          'The artwork storage path does not match its pinned version.');
    }
    final signed = Uri.tryParse(await api.assetDownloadUrl(assetId, version));
    final base = Uri.parse(storageBaseUrl);
    if (signed == null ||
        signed.scheme != base.scheme ||
        !signed.hasAuthority ||
        signed.host != base.host ||
        signed.port != base.port ||
        signed.userInfo.isNotEmpty ||
        signed.hasFragment ||
        signed.pathSegments.join('/') !=
            'storage/v1/object/sign/book-assets/$path' ||
        signed.queryParametersAll.keys.any((key) => key != 'token') ||
        signed.queryParametersAll['token']?.length != 1 ||
        (signed.queryParameters['token'] ?? '').isEmpty) {
      throw manuscriptError(
          'The private preview link does not match the trusted storage location.');
    }
    final client = _clientFactory();
    try {
      return await (() async {
        api.ensureCurrent();
        final request = http.Request('GET', signed)..followRedirects = false;
        final response = await client.send(request);
        api.ensureCurrent();
        if (response.statusCode != 200 ||
            response.headers['content-type']
                    ?.split(';')
                    .first
                    .trim()
                    .toLowerCase() !=
                mime ||
            (response.contentLength != null &&
                response.contentLength != size)) {
          throw manuscriptError(
              'The private artwork preview could not be verified. Refresh to try again.');
        }
        final bytes = BytesBuilder(copy: false);
        await for (final chunk in response.stream) {
          api.ensureCurrent();
          if (bytes.length + chunk.length > size)
            throw manuscriptError(
                'The artwork preview exceeds its recorded size.');
          bytes.add(chunk);
        }
        api.ensureCurrent();
        final result = bytes.takeBytes();
        if (result.length != size ||
            sha256.convert(result).toString() != checksum.toLowerCase()) {
          throw manuscriptError(
              'The artwork bytes do not match the saved version. No image was inserted.');
        }
        final buffer = await ui.ImmutableBuffer.fromUint8List(result);
        try {
          final image = await ui.ImageDescriptor.encoded(buffer);
          try {
            if (image.width < 1 ||
                image.height < 1 ||
                image.width > 16384 ||
                image.height > 16384 ||
                image.width * image.height > 40000000) {
              throw manuscriptError(
                  'This image exceeds the native preview pixel limit. The original is preserved.');
            }
            final codec = await image.instantiateCodec(
                targetWidth: image.width > 1024 ? 1024 : image.width);
            try {
              final frame = await codec.getNextFrame();
              frame.image.dispose();
            } finally {
              codec.dispose();
            }
          } finally {
            image.dispose();
          }
        } on ApiError {
          rethrow;
        } on Exception {
          throw manuscriptError(
              'The saved image could not be decoded. No image was inserted.');
        } finally {
          buffer.dispose();
        }
        api.ensureCurrent();
        return ArtworkPreview(result, version, checksum);
      })()
          .timeout(timeout);
    } on TimeoutException {
      throw manuscriptError(
          'The private preview timed out. Refresh to try again.');
    } on http.ClientException {
      throw manuscriptError(
          'The private preview could not be loaded. Check your connection.');
    } finally {
      client.close();
    }
  }
}
