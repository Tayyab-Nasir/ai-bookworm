import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../auth.dart';
import '../models.dart';

/// Assets browse + upload. Upload follows the signed-URL flow:
/// create upload-url -> upload bytes to signed storage URL -> confirm checksum.
/// Ponytail: no file_picker dep in the MVP; upload posts a small text note.
/// Swap _pickFile for file_picker when real device uploads land.
class AssetsScreen extends StatefulWidget {
  const AssetsScreen({super.key, required this.auth});
  final AuthState auth;

  @override
  State<AssetsScreen> createState() => _AssetsScreenState();
}

class _AssetsScreenState extends State<AssetsScreen> {
  List<AssetItem> _assets = const [];
  String? _error;
  bool _loading = true;
  bool _uploading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = widget.auth.api;
    final ws = widget.auth.workspace;
    if (api == null || ws == null) {
      if (mounted) {
        setState(() {
          _assets = const [];
          _loading = false;
        });
      }
      return;
    }
    setState(() => _loading = true);
    try {
      final assets = await api.listAssets(ws.id);
      if (mounted) {
        setState(() {
          _assets = assets;
          _loading = false;
          _error = null;
        });
      }
    } on Exception catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _pickAndUpload() async {
    final api = widget.auth.api;
    final ws = widget.auth.workspace;
    if (api == null || ws == null) return;
    setState(() => _uploading = true);
    try {
      // Placeholder payload; real picker returns (name, mimeType, bytes).
      final bytes = Uint8List.fromList(utf8.encode(
          'Uploaded from mobile at ${DateTime.now().toIso8601String()}'));
      const filename = 'note.txt';
      const mimeType = 'text/plain';
      final urls = await api.createAssetUploadUrl(ws.id,
          filename: filename, mimeType: mimeType, sizeBytes: bytes.length);
      await Supabase.instance.client.storage
          .from('book-assets')
          .uploadToSignedUrl(urls['path']!, _tokenFrom(urls['uploadUrl']!),
              bytes,
              fileOptions: const FileOptions(contentType: mimeType));
      await api.confirmAssetUpload(urls['assetId']!,
          checksumSha256: sha256.convert(bytes).toString(),
          sizeBytes: bytes.length);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Uploaded')));
      }
      await _load();
    } on Exception catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  String _tokenFrom(String signedUrl) {
    final t = Uri.parse(signedUrl).queryParameters['token'];
    if (t == null) throw StateError('signed URL missing token');
    return t;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Assets')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _uploading ? null : _pickAndUpload,
        icon: const Icon(Icons.upload),
        label: Text(_uploading ? 'Uploading…' : 'Upload'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          children: [
            if (_error != null) Text(_error!),
            if (_loading) const LinearProgressIndicator(),
            for (final a in _assets)
              ListTile(
                leading: Icon(a.mimeType.startsWith('image/')
                    ? Icons.image_outlined
                    : Icons.description_outlined),
                title: Text(a.name),
                subtitle: Text(
                    '${a.type} • ${(a.sizeBytes / 1024).toStringAsFixed(1)} KB • ${a.status}'),
              ),
            if (_assets.isEmpty && !_loading)
              const ListTile(title: Text('No assets yet')),
          ],
        ),
      ),
    );
  }
}
