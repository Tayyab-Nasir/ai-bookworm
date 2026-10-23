import 'package:flutter/material.dart';

import '../chapter_document.dart';
import '../manuscript_artwork.dart';
import '../manuscript_draft.dart';
import '../models.dart';

class ManuscriptArtworkEditor extends StatefulWidget {
  const ManuscriptArtworkEditor({super.key, required this.artwork, this.node});
  final NativeArtwork artwork;
  final Map<String, dynamic>? node;
  @override
  State<ManuscriptArtworkEditor> createState() =>
      _ManuscriptArtworkEditorState();
}

class _ManuscriptArtworkEditorState extends State<ManuscriptArtworkEditor> {
  late final _alt =
      TextEditingController(text: widget.node?['altText'] as String? ?? '');
  late final _caption =
      TextEditingController(text: widget.node?['caption'] as String? ?? '');
  late final _attrs = {...?widget.node?['attributes'] as Map<String, dynamic>?};
  late bool _decorative = _attrs['decorative'] == true;
  late String _placement =
      _attrs['printPlacement'] == 'fullBleed' ? 'fullBleed' : 'inline';
  late double _width = _number('widthPercent', 100, 25, 100),
      _x = _number('printFocalX', 50, 0, 100),
      _y = _number('printFocalY', 50, 0, 100);
  List<AssetItem> _assets = [];
  AssetItem? _selected;
  ArtworkPreview? _preview;
  String? _error;
  bool _busy = true, _dirty = false, _allowExit = false;
  int _generation = 0;
  bool get _new => widget.node == null;
  double _number(String key, double fallback, double min, double max) =>
      _attrs[key] is num && (_attrs[key] as num).isFinite
          ? (_attrs[key] as num).toDouble().clamp(min, max)
          : fallback;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _generation++;
    _alt.dispose();
    _caption.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
      _preview = null;
    });
    try {
      if (_new) {
        final assets = await widget.artwork.available();
        if (mounted && generation == _generation)
          setState(() {
            _assets = assets;
            _selected = null;
          });
      } else {
        final node = widget.node!,
            id = node['assetId'],
            version = node['assetVersionNumber'];
        if (id is! String || version is! int)
          throw manuscriptError(
              'This artwork has no exact version pin. The reference is preserved; reinsert a reviewed version to preview it.');
        final preview = await widget.artwork.preview(id, version);
        if (mounted && generation == _generation)
          setState(() => _preview = preview);
      }
    } on ApiError catch (error) {
      if (mounted && generation == _generation)
        setState(() => _error = error.message);
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _select(AssetItem asset) async {
    final generation = ++_generation;
    setState(() {
      _selected = asset;
      _preview = null;
      _error = null;
      _busy = true;
      _dirty = true;
    });
    try {
      final preview = await widget.artwork.preview(asset.id, asset.version!);
      await widget.artwork.verifySelection(asset, preview);
      if (mounted && generation == _generation)
        setState(() => _preview = preview);
    } on ApiError catch (error) {
      if (mounted && generation == _generation)
        setState(() => _error = error.message);
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _finish() async {
    if (_busy) return;
    if (!_decorative && _alt.text.trim().isEmpty) {
      setState(() =>
          _error = 'Describe the image, or mark it as purely decorative.');
      return;
    }
    setState(() => _busy = true);
    try {
      widget.artwork.api.ensureCurrent();
      if (_alt.text.length > 1000 || _caption.text.length > 2000)
        throw manuscriptError(
            'The description or caption exceeds its supported length. Shorten it before applying.');
      if (_new) {
        if (_selected == null || _preview == null)
          throw manuscriptError('Choose and preview a cleared image first.');
        await widget.artwork.verifySelection(_selected!, _preview!);
      }
      final value = <String, dynamic>{
        ...?widget.node,
        if (_new) ...{
          'id': newManuscriptId(),
          'type': 'image',
          'assetId': _selected!.id,
          'assetVersionNumber': _selected!.version
        },
        'altText': _decorative ? '' : _alt.text.trim(),
        'caption': _caption.text.trim(),
        'attributes': {
          ..._attrs,
          'decorative': _decorative,
          'widthPercent': _width.round(),
          'printPlacement': _placement,
          'printFocalX': _x.round(),
          'printFocalY': _y.round()
        },
      };
      if (!mounted) return;
      setState(() => _allowExit = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.pop(context, value);
      });
    } on ApiError catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _leave() async {
    if (_busy) return;
    final discard = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
                title: const Text('Discard artwork form changes?'),
                content: const Text(
                    'These changes have not entered the manuscript draft. The original artwork file and existing chapter are unchanged.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('Keep editing')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('Discard form'))
                ]));
    if (discard == true && mounted) {
      setState(() => _allowExit = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.pop(context);
      });
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
      canPop: _allowExit || !_dirty && !_busy,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _leave();
      },
      child: Scaffold(
        appBar: AppBar(
            title: Text(_new ? 'Insert illustration' : 'Artwork settings')),
        body: SafeArea(
            child: ListView(padding: const EdgeInsets.all(20), children: [
          Text(
              _new
                  ? 'Choose a cleared workspace image. Its exact version stays pinned in this chapter.'
                  : 'This preview uses the pinned version, never a silently replaced image.',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 12),
          if (_busy) const LinearProgressIndicator(),
          if (_error != null)
            Semantics(
                liveRegion: true,
                child: Text(_error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error))),
          if (_new) ...[
            if (!_busy && _assets.isEmpty)
              const Text(
                  'No cleared artwork yet. Upload artwork in Assets, complete any required approval, then refresh.'),
            for (final asset in _assets)
              ListTile(
                  title: Text(asset.name),
                  subtitle: Text(
                      'Version ${asset.version} · ${asset.requiresApproval == true ? 'approved' : 'cleared for use'}'),
                  selected: _selected?.id == asset.id,
                  trailing: const Icon(Icons.image_outlined),
                  onTap: _busy ? null : () => _select(asset)),
            TextButton(
                onPressed: _busy ? null : _load,
                child: const Text('Refresh artwork library')),
          ],
          if (_preview != null) ...[
            Semantics(
                label: 'Pinned artwork version ${_preview!.version}',
                child: Image.memory(_preview!.bytes,
                    cacheWidth: 1024,
                    height: 260,
                    fit: BoxFit.contain,
                    semanticLabel: _decorative ? null : _alt.text,
                    excludeFromSemantics: _decorative,
                    errorBuilder: (_, __, ___) => const Text(
                        'Image display unavailable. Refresh the private preview.'))),
            Text('Pinned version ${_preview!.version}',
                textAlign: TextAlign.center),
          ],
          TextButton(
              onPressed: _busy
                  ? null
                  : _selected != null
                      ? () => _select(_selected!)
                      : !_new
                          ? _load
                          : null,
              child: const Text('Refresh private preview')),
          const SizedBox(height: 12),
          TextField(
              controller: _alt,
              enabled: !_busy && !_decorative,
              maxLength: 1000,
              maxLines: null,
              decoration: const InputDecoration(
                  labelText: 'Image description (alt text)',
                  border: OutlineInputBorder()),
              onChanged: (_) => setState(() => _dirty = true)),
          CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Purely decorative image'),
              value: _decorative,
              onChanged: _busy
                  ? null
                  : (value) => setState(() {
                        _decorative = value!;
                        _dirty = true;
                      })),
          TextField(
              controller: _caption,
              enabled: !_busy,
              maxLength: 2000,
              maxLines: null,
              decoration: const InputDecoration(
                  labelText: 'Caption', border: OutlineInputBorder()),
              onChanged: (_) => setState(() => _dirty = true)),
          Wrap(spacing: 8, children: [
            for (final entry in {
              'inline': 'Inside text area',
              'fullBleed': 'Full-bleed print page'
            }.entries)
              ChoiceChip(
                  label: Text(entry.value),
                  selected: _placement == entry.key,
                  onSelected: _busy
                      ? null
                      : (_) => setState(() {
                            _placement = entry.key;
                            _dirty = true;
                          }))
          ]),
          if (_placement == 'inline') ...[
            Text('Text width: ${_width.round()}%'),
            Slider(
                label: '${_width.round()}%',
                value: _width,
                min: 25,
                max: 100,
                divisions: 75,
                onChanged: _busy
                    ? null
                    : (value) => setState(() {
                          _width = value;
                          _dirty = true;
                        }))
          ] else ...[
            const Text(
                'Print uses a dedicated page cropped through the bleed. Ebook placement remains inline. Preflight checks image resolution.'),
            Text('Horizontal crop focus: ${_x.round()}%'),
            Slider(
                label: '${_x.round()}%',
                value: _x,
                min: 0,
                max: 100,
                divisions: 100,
                onChanged: _busy
                    ? null
                    : (value) => setState(() {
                          _x = value;
                          _dirty = true;
                        })),
            Text('Vertical crop focus: ${_y.round()}%'),
            Slider(
                label: '${_y.round()}%',
                value: _y,
                min: 0,
                max: 100,
                divisions: 100,
                onChanged: _busy
                    ? null
                    : (value) => setState(() {
                          _y = value;
                          _dirty = true;
                        })),
          ],
          const Text(
              'This changes your draft only. Save the chapter afterward. No image is generated and no credits are spent.'),
          const SizedBox(height: 16),
          FilledButton(
              onPressed: _busy || _new && _preview == null ? null : _finish,
              child: Text(_new ? 'Insert into draft' : 'Use artwork settings')),
        ])),
      ));
}

class PrivateArtworkPreview extends StatefulWidget {
  const PrivateArtworkPreview(
      {super.key, required this.artwork, required this.node});
  final NativeArtwork artwork;
  final Map<String, dynamic> node;
  @override
  State<PrivateArtworkPreview> createState() => _PrivateArtworkPreviewState();
}

class _PrivateArtworkPreviewState extends State<PrivateArtworkPreview> {
  ArtworkPreview? _preview;
  String? _error;
  bool _busy = false;
  int _generation = 0;
  @override
  void didUpdateWidget(covariant PrivateArtworkPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.node['assetId'] != widget.node['assetId'] ||
        oldWidget.node['assetVersionNumber'] !=
            widget.node['assetVersionNumber'] ||
        oldWidget.artwork != widget.artwork) {
      _generation++;
      _preview = null;
      _error = null;
      _busy = false;
    }
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
      _preview = null;
    });
    try {
      final id = widget.node['assetId'],
          version = widget.node['assetVersionNumber'];
      if (id is! String || version is! int)
        throw manuscriptError(
            'No exact artwork version is recorded. The reference is preserved; select a reviewed version to preview it.');
      final preview = await widget.artwork.preview(id, version);
      if (mounted && generation == _generation)
        setState(() => _preview = preview);
    } on ApiError catch (error) {
      if (mounted && generation == _generation)
        setState(() => _error = error.message);
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (_busy) const LinearProgressIndicator(),
        if (_preview != null)
          Image.memory(_preview!.bytes,
              cacheWidth: 1024,
              height: 220,
              fit: BoxFit.contain,
              semanticLabel: widget.node['altText'] as String?,
              excludeFromSemantics:
                  (widget.node['attributes'] as Map?)?['decorative'] == true,
              errorBuilder: (_, __, ___) => const Text(
                  'Image display unavailable. Refresh the private preview.')),
        if (_error != null) Semantics(liveRegion: true, child: Text(_error!)),
        TextButton.icon(
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.image_outlined),
            label: Text(_preview == null && _error == null
                ? 'Preview pinned artwork'
                : 'Refresh private preview')),
      ]);
}
