import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../asset_upload.dart';
import '../auth.dart';
import '../book_workflow.dart';
import '../models.dart';

class AssetsScreen extends StatefulWidget {
  const AssetsScreen(
      {super.key,
      required this.auth,
      this.selectManuscript = false,
      this.selectFile,
      this.storageClientFactory});
  final AuthState auth;
  final bool selectManuscript;
  final Future<XFile?> Function()? selectFile;
  final http.Client Function()? storageClientFactory;
  @override
  State<AssetsScreen> createState() => _AssetsScreenState();
}

class _AssetsScreenState extends State<AssetsScreen> {
  List<AssetItem> _assets = const [];
  NativeAssetUpload? _upload;
  String? _error, _message;
  String _kind = 'source_document';
  bool _loading = true, _busy = false, _recoveryUnavailable = false;
  int _loadGeneration = 0;
  static const _labels = {
    'source_document': 'Source document',
    'manuscript': 'Manuscript',
    'illustration': 'Illustration',
    'cover': 'Cover artwork'
  };

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  String _safeError(Object error) => error is ApiError
      ? error.message
      : 'The file operation could not be confirmed. Keep your retry details and check saved status.';

  Future<void> _initialize() async {
    final api = widget.auth.api,
        workspace = widget.auth.workspace,
        user = widget.auth.user;
    if (api == null || workspace == null || user == null) {
      setState(() {
        _loading = false;
        _error = 'Select a workspace before opening files.';
      });
      return;
    }
    _upload = NativeAssetUpload(
        api: api,
        workspaceId: workspace.id,
        userId: user.id,
        storageBaseUrl: widget.auth.storageBaseUrl,
        uploadClientFactory: widget.storageClientFactory);
    try {
      await _upload!.load();
    } on Exception catch (error) {
      if (mounted)
        setState(() {
          _recoveryUnavailable = true;
          _message = _safeError(error);
        });
    }
    if (mounted) await _load();
  }

  Future<void> _load() async {
    final api = widget.auth.api, workspace = widget.auth.workspace;
    if (api == null || workspace == null || !mounted) return;
    final generation = ++_loadGeneration;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final assets = await api.listAssets(workspace.id);
      if (mounted && generation == _loadGeneration)
        setState(() {
          _assets = assets;
          _loading = false;
        });
    } on Exception catch (error) {
      if (mounted && generation == _loadGeneration)
        setState(() {
          _assets = const [];
          _loading = false;
          _error = _safeError(error);
        });
    }
  }

  Future<void> _choose() async {
    final upload = _upload;
    if (_busy || upload == null || _recoveryUnavailable) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final file = await (widget.selectFile?.call() ??
          openFile(acceptedTypeGroups: [
            XTypeGroup(
                label: 'Bookworm documents and images',
                extensions: widget.selectManuscript
                    ? manuscriptImportExtensions
                    : assetMimeTypes.keys.toList(),
                mimeTypes: assetMimeTypes.values.toSet().toList(),
                uniformTypeIdentifiers: const ['public.data'])
          ]));
      if (file == null || !mounted) return;
      upload.api.ensureCurrent();
      final size = await file.length();
      if (widget.selectManuscript &&
          (!manuscriptImportExtensions
                  .contains(file.name.split('.').last.toLowerCase()) ||
              size < 1 ||
              size > maxManuscriptImportBytes)) {
        throw ApiError(422, 'invalid_manuscript',
            'Choose a non-empty TXT, DOCX, EPUB or PDF up to 20 MiB.', '');
      }
      if (!mounted) return;
      final accepted = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
                title: const Text('Upload this file?'),
                content: Text(
                    '${file.name}\n${(size / (1024 * 1024)).toStringAsFixed(2)} MiB\n\n'
                    'This sends the file to your private workspace. It stays unavailable until file checks and malware screening pass.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(dialogContext, false),
                      child: const Text('Cancel')),
                  FilledButton(
                      onPressed: () => Navigator.pop(dialogContext, true),
                      child: const Text('Upload file'))
                ],
              ));
      if (accepted != true || !mounted) return;
      await upload.upload(file,
          type: upload.pending?.type ??
              (widget.selectManuscript ? 'manuscript' : _kind));
      if (mounted)
        setState(() => _message =
            'Upload verified and screened. Your file is saved in Assets.');
      if (mounted) await _load();
    } on Exception catch (error) {
      if (mounted) setState(() => _message = _safeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _recover() async {
    if (_busy || _upload == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final complete = await _upload!.recover();
      if (mounted)
        setState(() => _message = complete
            ? 'The original upload is verified and screened.'
            : 'Upload is not confirmed yet. Select the original unchanged file to resume.');
      if (mounted) await _load();
    } on Exception catch (error) {
      if (mounted) setState(() => _message = _safeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _retryAccess() async {
    if (_busy || _upload == null) return;
    setState(() => _busy = true);
    try {
      await _upload!.load();
      if (mounted)
        setState(() {
          _recoveryUnavailable = false;
          _message = null;
        });
    } on Exception catch (error) {
      if (mounted) setState(() => _message = _safeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _forget() async {
    if (_busy || _upload == null) return;
    final accepted = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
              title: const Text('Discard local retry details?'),
              content: const Text(
                  'Check Assets first: the server may already have this file. This removes only the saved retry details on this device. It does not delete or cancel any uploaded file. Uploading again may create another asset.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dialogContext, false),
                    child: const Text('Keep details')),
                TextButton(
                    onPressed: () => Navigator.pop(dialogContext, true),
                    child: const Text('Discard retry details'))
              ],
            ));
    if (accepted != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await _upload!.forget();
      if (mounted)
        setState(() {
          _recoveryUnavailable = false;
          _message =
              'Local retry details removed. Server files were not changed.';
        });
    } on Exception catch (error) {
      if (mounted) setState(() => _message = _safeError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pending = _upload?.pending;
    return Scaffold(
      appBar: AppBar(
          title: Text(widget.selectManuscript
              ? 'Choose a manuscript'
              : 'Files & artwork')),
      body: SafeArea(
          child: RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(20),
                children: [
                  Text('Bring your book to life',
                      style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  Text(widget.selectManuscript
                      ? 'Choose a screened TXT, DOCX, EPUB or PDF up to 20 MiB, or upload one below. Uploading does not start an import. Scanned PDFs need OCR first.'
                      : 'DOCX, EPUB, PDF, text, Markdown, PNG, JPEG, WebP or GIF. Up to 100 MiB per file. Files remain private and must pass screening.'),
                  const SizedBox(height: 20),
                  if (!widget.selectManuscript &&
                      pending == null &&
                      !_recoveryUnavailable) ...[
                    DropdownButtonFormField<String>(
                        initialValue: _kind,
                        isExpanded: true,
                        isDense: false,
                        itemHeight: null,
                        decoration:
                            const InputDecoration(labelText: 'File purpose'),
                        items: [
                          for (final kind in assetKinds)
                            DropdownMenuItem(
                                value: kind,
                                child: Text(_labels[kind]!,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis))
                        ],
                        onChanged: _busy
                            ? null
                            : (kind) => setState(() => _kind = kind!)),
                    const SizedBox(height: 12),
                  ],
                  if (pending != null) ...[
                    Text('Saved upload: ${pending.name}',
                        style: Theme.of(context).textTheme.titleMedium),
                    const Text(
                        'Check its saved status, or select the same unchanged file to resume without creating a second asset.'),
                    const SizedBox(height: 12),
                    OutlinedButton(
                        onPressed: _busy ? null : _recover,
                        child: const Text('Check saved upload')),
                  ],
                  FilledButton.icon(
                      onPressed:
                          _busy || _upload == null || _recoveryUnavailable
                              ? null
                              : _choose,
                      icon: const Icon(Icons.upload_file),
                      label: Text(_busy
                          ? 'Working…'
                          : pending == null
                              ? 'Choose file and upload'
                              : 'Resume original upload')),
                  if (_recoveryUnavailable)
                    OutlinedButton(
                        onPressed: _busy ? null : _retryAccess,
                        child: const Text('Retry saved upload access')),
                  if (pending != null || _recoveryUnavailable)
                    TextButton(
                        onPressed: _busy ? null : _forget,
                        child: const Text('Discard local retry details')),
                  if (_message != null)
                    Semantics(
                        liveRegion: true,
                        child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 12),
                            child: Text(_message!))),
                  const Divider(height: 32),
                  if (_loading) const LinearProgressIndicator(),
                  if (_error != null) ...[
                    Text(_error!),
                    TextButton(
                        onPressed: _load, child: const Text('Retry file list'))
                  ],
                  for (final asset in _assets)
                    ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(asset.mimeType.startsWith('image/')
                            ? Icons.image_outlined
                            : Icons.description_outlined),
                        title: Text(asset.name),
                        onTap: widget.selectManuscript &&
                                canImportAsset(asset) &&
                                !_busy
                            ? () {
                                try {
                                  _upload!.api.ensureCurrent();
                                  Navigator.pop(context, asset);
                                } on Exception catch (error) {
                                  setState(() => _message = _safeError(error));
                                }
                              }
                            : null,
                        trailing:
                            widget.selectManuscript && canImportAsset(asset)
                                ? const Icon(Icons.chevron_right)
                                : null,
                        subtitle: Text(
                            '${_labels[asset.type] ?? asset.type} · ${(asset.sizeBytes / 1024).toStringAsFixed(1)} KiB\n'
                            '${asset.scanStatus == 'clean' ? 'Screening passed' : 'Not cleared for use: ${asset.scanStatus ?? 'awaiting screening'}'}')),
                  if (_assets.isEmpty && !_loading && _error == null)
                    const Padding(
                        padding: EdgeInsets.symmetric(vertical: 24),
                        child: Text(
                            'No files yet. Add a manuscript, reference document or artwork to get started.')),
                ],
              ))),
    );
  }
}
