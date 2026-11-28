import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../chapter_document.dart';
import '../manuscript_draft.dart';
import '../models.dart';
import '../manuscript_artwork.dart';
import 'manuscript_artwork_editor.dart';
import 'manuscript_table_editor.dart';

class ManuscriptEditor extends StatefulWidget {
  const ManuscriptEditor(
      {super.key,
      required this.editor,
      required this.title,
      this.onComments,
      this.artwork});
  final ManuscriptDraft editor;
  final String title;
  final VoidCallback? onComments;
  final NativeArtwork? artwork;
  @override
  State<ManuscriptEditor> createState() => _ManuscriptEditorState();
}

class _ManuscriptEditorState extends State<ManuscriptEditor> {
  bool _allowExit = false, _leaving = false;
  Timer? _checkpoint;
  ChapterDocument? _scheduledDraft;
  ManuscriptDraft get editor => widget.editor;
  @override
  void initState() {
    super.initState();
    editor.addListener(_changed);
    unawaited(editor.load());
  }

  void _changed() {
    final changed = !identical(_scheduledDraft, editor.draft);
    _scheduledDraft = editor.draft;
    if (changed || editor.busy) _checkpoint?.cancel();
    if (changed && editor.canEdit && editor.dirty && !editor.durable) {
      _checkpoint = Timer(const Duration(milliseconds: 750),
          () => unawaited(editor.checkpointDraft()));
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _checkpoint?.cancel();
    editor.removeListener(_changed);
    super.dispose();
  }

  Future<bool> _confirm(String title, String body, String action) async =>
      await showDialog<bool>(
          context: context,
          builder: (context) =>
              AlertDialog(title: Text(title), content: Text(body), actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('Cancel')),
                FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: Text(action)),
              ])) ??
      false;

  Future<void> _leave() async {
    if (_leaving || editor.busy) return;
    _leaving = true;
    try {
      if ((editor.dirty || editor.operationId != null) && !editor.durable) {
        if (!await _confirm(
            'Keep your draft?',
            'Keep these changes securely on this device before leaving? This does not save them online.',
            'Keep draft')) return;
        await editor.keepDraft();
        if (!editor.durable || !mounted) return;
      }
      if (!mounted) return;
      setState(() => _allowExit = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).pop();
      });
    } finally {
      _leaving = false;
    }
  }

  void _changeNodes(List<Map<String, dynamic>> nodes) {
    try {
      editor.updateNodes(nodes);
    } on ApiError catch (error) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _remove(int index) async {
    if (!await _confirm(
            'Remove this block?',
            'This removes the block from your local draft. Existing saved versions are retained.',
            'Remove block') ||
        !mounted ||
        !editor.canEdit) return;
    _changeNodes([...editor.draft!.nodes]..removeAt(index));
  }

  Future<void> _compare() async {
    await editor.recover();
    if (!mounted || editor.latest == null || editor.draft == null) return;
    final remote = editor.latest!;
    final result =
        await showDialog<({Map<String, bool> choices, bool? localOrder})>(
            context: context,
            builder: (_) => _ManuscriptComparison(
                base: editor.base!, local: editor.draft!, remote: remote));
    if (result != null && mounted)
      await editor.mergeLatest(
          localChoices: result.choices,
          localOrder: result.localOrder,
          reviewedVersion: remote.version);
  }

  void _replaceBlock(String id, Map<String, dynamic> value) {
    final nodes = [...editor.draft!.nodes],
        index = editor.draft!.nodes.indexWhere((node) => node['id'] == id);
    if (index < 0)
      throw manuscriptError(
          'This block is no longer in the draft. Reopen the manuscript.');
    nodes[index] = value;
    editor.updateNodes(nodes);
  }

  Future<void> _editTable(Map<String, dynamic> node) async {
    if (editor.draft == null) return;
    await Navigator.push<void>(
        context,
        MaterialPageRoute(
            builder: (_) => ManuscriptTableEditor(
                node: node,
                readOnly: !editor.canEdit,
                validateNode: (value) {
                  final nodes = [...editor.draft!.nodes];
                  final index = nodes.indexWhere((n) => n['id'] == node['id']);
                  if (index < 0)
                    throw manuscriptError(
                        'This table is no longer in the draft.');
                  nodes[index] = value;
                  editor.base!.withNodes(nodes);
                },
                onChanged: (value) =>
                    _replaceBlock(node['id'] as String, value))));
  }

  Future<void> _editArtwork([Map<String, dynamic>? node]) async {
    if (!editor.canEdit || widget.artwork == null) return;
    final value = await Navigator.push<Map<String, dynamic>>(
        context,
        MaterialPageRoute(
            builder: (_) =>
                ManuscriptArtworkEditor(artwork: widget.artwork!, node: node)));
    if (value == null || !mounted || !editor.canEdit) return;
    try {
      if (node == null) {
        editor.updateNodes([...editor.draft!.nodes, value]);
      } else {
        _replaceBlock(node['id'] as String, value);
      }
    } on ApiError catch (error) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final document = editor.draft;
    return PopScope(
        canPop: _allowExit ||
            !editor.busy &&
                (!editor.dirty || editor.durable) &&
                editor.operationId == null,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) unawaited(_leave());
        },
        child: Scaffold(
          appBar: AppBar(title: Text(widget.title), actions: [
            if (widget.onComments != null)
              IconButton(
                  tooltip: 'Chapter comments',
                  onPressed: editor.busy ? null : widget.onComments,
                  icon: const Icon(Icons.comment_outlined)),
            IconButton(
                tooltip: 'Save manuscript',
                onPressed: editor.canSave ? editor.save : null,
                icon: const Icon(Icons.save_outlined)),
          ]),
          body: SafeArea(
              child: Column(children: [
            if (editor.busy) const LinearProgressIndicator(),
            Container(
                width: double.infinity,
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                padding: const EdgeInsets.all(12),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Semantics(
                          liveRegion: true,
                          child: Text(editor.message,
                              key: const ValueKey('manuscript-status'))),
                      if (document != null &&
                          !manuscriptEditRoles.contains(editor.role))
                        const Text(
                            'Read-only access. Your local draft, if any, is preserved.'),
                      Wrap(spacing: 8, runSpacing: 4, children: [
                        if (document != null &&
                            (editor.dirty || editor.operationId != null))
                          TextButton(
                              onPressed: editor.busy ? null : editor.keepDraft,
                              child: const Text('Keep draft on device')),
                        TextButton(
                            onPressed: editor.busy
                                ? null
                                : document == null
                                    ? editor.load
                                    : editor.recover,
                            child: Text(editor.operationId == null
                                ? 'Check saved version'
                                : 'Check original save')),
                        if (editor.phase == ManuscriptPhase.conflict) ...[
                          TextButton(
                              onPressed: editor.busy ? null : _compare,
                              child: const Text('Compare versions')),
                          TextButton(
                              onPressed:
                                  editor.busy ? null : editor.mergeLatest,
                              child: const Text('Merge non-conflicting edits')),
                        ],
                        if (document != null &&
                            (editor.dirty || editor.operationId != null))
                          TextButton(
                              onPressed: editor.busy
                                  ? null
                                  : () async {
                                      if (await _confirm(
                                              'Discard local changes?',
                                              'This deletes this device’s draft and loads the saved chapter. An unconfirmed save may still complete on the server; this does not cancel it.',
                                              'Discard and reload') &&
                                          mounted)
                                        await editor.discardAndReload();
                                    },
                              child: const Text('Discard local draft')),
                      ]),
                    ])),
            Expanded(
                child: document == null
                    ? Center(
                        child: Text(editor.busy
                            ? 'Loading manuscript…'
                            : 'Manuscript unavailable. Retry without discarding your draft.'))
                    : ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: document.nodes.length + 1,
                        itemBuilder: (context, index) {
                          if (index == document.nodes.length)
                            return Padding(
                                padding:
                                    const EdgeInsets.symmetric(vertical: 16),
                                child:
                                    Wrap(spacing: 8, runSpacing: 8, children: [
                                  OutlinedButton.icon(
                                      onPressed: editor.canEdit
                                          ? () => _changeNodes([
                                                ...document.nodes,
                                                {
                                                  'id': newManuscriptId(),
                                                  'type': 'paragraph',
                                                  'text': ''
                                                }
                                              ])
                                          : null,
                                      icon: const Icon(Icons.add),
                                      label: const Text('Add paragraph')),
                                  OutlinedButton.icon(
                                      onPressed: editor.canEdit
                                          ? () {
                                              final node = <String, dynamic>{
                                                'id': newManuscriptId(),
                                                'type': 'table',
                                                'rows': [
                                                  ['', ''],
                                                  ['', '']
                                                ],
                                                'text': '\t\n\t',
                                                'attributes': {
                                                  'tableHeaderRows': 1
                                                }
                                              };
                                              try {
                                                editor.updateNodes([
                                                  ...editor.draft!.nodes,
                                                  node
                                                ]);
                                                _editTable(node);
                                              } on ApiError catch (error) {
                                                ScaffoldMessenger.of(context)
                                                    .showSnackBar(SnackBar(
                                                        content: Text(
                                                            error.message)));
                                              }
                                            }
                                          : null,
                                      icon: const Icon(
                                          Icons.table_chart_outlined),
                                      label: const Text('Add table')),
                                  OutlinedButton.icon(
                                      onPressed: editor.canEdit &&
                                              widget.artwork != null
                                          ? () => _editArtwork()
                                          : null,
                                      icon: const Icon(
                                          Icons.add_photo_alternate_outlined),
                                      label: const Text('Add illustration')),
                                  OutlinedButton.icon(
                                      onPressed: editor.canEdit
                                          ? () => _changeNodes([
                                                ...editor.draft!.nodes,
                                                {
                                                  'id': newManuscriptId(),
                                                  'type': 'pageBreak'
                                                }
                                              ])
                                          : null,
                                      icon: const Icon(
                                          Icons.insert_page_break_outlined),
                                      label: const Text('Add page break')),
                                ]));
                          final node = document.nodes[index];
                          return _ManuscriptBlock(
                              key: ValueKey(node['id']),
                              node: node,
                              editable: editor.canEdit,
                              artwork: widget.artwork,
                              onEditTable: () => _editTable(node),
                              onEditArtwork: () => _editArtwork(node),
                              onChanged: (value) => _changeNodes(
                                  [...editor.draft!.nodes]..[index] = value),
                              validateNode: (value) => editor.base!.withNodes(
                                  [...editor.draft!.nodes]..[index] = value),
                              onDelete: () => _remove(index),
                              onMove: (direction) {
                                final next = index + direction;
                                if (!editor.canEdit ||
                                    next < 0 ||
                                    next >= document.nodes.length) return;
                                final nodes = [...document.nodes];
                                nodes.insert(next, nodes.removeAt(index));
                                _changeNodes(nodes);
                              });
                        })),
          ])),
        ));
  }
}

class _ManuscriptComparison extends StatefulWidget {
  const _ManuscriptComparison(
      {required this.base, required this.local, required this.remote});
  final ChapterDocument base, local, remote;
  @override
  State<_ManuscriptComparison> createState() => _ManuscriptComparisonState();
}

class _ManuscriptComparisonState extends State<_ManuscriptComparison> {
  final _choices = <String, bool>{};
  bool? _localOrder;
  late final _conflicts =
      manuscriptConflicts(widget.base, widget.local, widget.remote);
  late final _orderConflict =
      manuscriptOrderConflict(widget.base, widget.local, widget.remote);
  Widget _preview(ChapterDocument document, String id) {
    final matches = document.nodes.where((node) => node['id'] == id);
    if (matches.isEmpty)
      return const Text('This block was removed in this copy.');
    return _ManuscriptBlock(
        node: matches.single,
        editable: false,
        onChanged: (_) {},
        validateNode: (_) {},
        onDelete: () {},
        onMove: (_) {});
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text('Review saved v${widget.remote.version}'),
        content: SizedBox(
            width: 600,
            height: MediaQuery.sizeOf(context).height * .6,
            child: ListView(children: [
              const Text(
                  'Choose which copy to keep for each overlapping block. All other edits merge automatically. This updates your local draft only; review it before saving online.'),
              if (_orderConflict) ...[
                const SizedBox(height: 16),
                const Text(
                    'Both copies changed block order or structure. The chosen order comes first; retained blocks present only in the other copy are appended.'),
                Text(
                    'My blocks: ${widget.local.nodes.map((node) => node['id']).join(', ')}'),
                Text(
                    'Saved blocks: ${widget.remote.nodes.map((node) => node['id']).join(', ')}'),
                Wrap(spacing: 8, children: [
                  ChoiceChip(
                      label: const Text('My block order'),
                      selected: _localOrder == true,
                      onSelected: (_) => setState(() => _localOrder = true)),
                  ChoiceChip(
                      label: const Text('Saved block order'),
                      selected: _localOrder == false,
                      onSelected: (_) => setState(() => _localOrder = false)),
                ]),
              ],
              for (final id in _conflicts) ...[
                const SizedBox(height: 20),
                Text('Conflicting block: $id',
                    style: Theme.of(context).textTheme.titleMedium),
                const Text('My draft'),
                _preview(widget.local, id),
                const Text('Saved copy'),
                _preview(widget.remote, id),
                Wrap(spacing: 8, children: [
                  ChoiceChip(
                      label: const Text('Use my block'),
                      selected: _choices[id] == true,
                      onSelected: (_) => setState(() => _choices[id] = true)),
                  ChoiceChip(
                      label: const Text('Use saved block'),
                      selected: _choices[id] == false,
                      onSelected: (_) => setState(() => _choices[id] = false)),
                ]),
              ],
              if (_conflicts.isEmpty && !_orderConflict)
                const Padding(
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: Text(
                        'No overlapping block changes. Both authors’ edits can be retained.')),
              ExpansionTile(
                  title: const Text('Full text comparison'),
                  children: [
                    const Text('My draft'),
                    SelectableText(widget.local.plainText),
                    const SizedBox(height: 16),
                    const Text('Saved copy'),
                    SelectableText(widget.remote.plainText),
                  ]),
            ])),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: _conflicts.every(_choices.containsKey) &&
                      (!_orderConflict || _localOrder != null)
                  ? () => Navigator.pop(context, (
                        choices: Map<String, bool>.from(_choices),
                        localOrder: _localOrder
                      ))
                  : null,
              child: const Text('Merge reviewed choices'))
        ],
      );
}

class _ManuscriptBlock extends StatefulWidget {
  const _ManuscriptBlock(
      {super.key,
      required this.node,
      required this.editable,
      required this.onChanged,
      required this.validateNode,
      this.artwork,
      this.onEditTable,
      this.onEditArtwork,
      required this.onDelete,
      required this.onMove});
  final Map<String, dynamic> node;
  final bool editable;
  final ValueChanged<Map<String, dynamic>> onChanged;
  final ValueChanged<Map<String, dynamic>> validateNode;
  final NativeArtwork? artwork;
  final VoidCallback? onEditTable, onEditArtwork;
  final VoidCallback onDelete;
  final ValueChanged<int> onMove;
  @override
  State<_ManuscriptBlock> createState() => _ManuscriptBlockState();
}

class _ManuscriptBlockState extends State<_ManuscriptBlock> {
  late final _controller = _RichManuscriptController(widget.node)
    ..addListener(_textChanged);
  bool _syncing = false;
  void _textChanged() {
    if (_syncing ||
        !widget.editable ||
        _controller.text == (_controller.node['text'] ?? '')) return;
    final next = replaceManuscriptText(_controller.node, _controller.text);
    _controller.node = next;
    widget.onChanged(next);
  }

  @override
  void didUpdateWidget(covariant _ManuscriptBlock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.node, widget.node)) return;
    _syncing = true;
    _controller.node = widget.node;
    final text = widget.node['text'] as String? ?? '';
    if (_controller.text != text)
      _controller.value = TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(
              offset:
                  _controller.selection.extentOffset.clamp(0, text.length)));
    _syncing = false;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _format(String mark) {
    try {
      widget.onChanged(toggleManuscriptMark(widget.node,
          _controller.selection.start, _controller.selection.end, mark));
    } on ApiError catch (error) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  void _action(String action) {
    if (action == 'delete') {
      widget.onDelete();
      return;
    }
    if (action == 'up' || action == 'down') {
      widget.onMove(action == 'up' ? -1 : 1);
      return;
    }
    final attributes = {...?widget.node['attributes'] as Map<String, dynamic>?};
    for (final key in [
      'listStyle',
      'listDepth',
      'listStart',
      'listReversed',
      'listNumberStyle'
    ]) {
      attributes.remove(key);
    }
    if (action == 'bullet' || action == 'numbered')
      attributes.addAll({
        'listStyle': action == 'bullet' ? 'bullet' : 'ordered',
        'listDepth': 0,
        if (action == 'numbered') 'listStart': 1
      });
    final next = {
      ...widget.node,
      'type': action.startsWith('heading')
          ? 'heading'
          : action == 'bullet' || action == 'numbered'
              ? 'listItem'
              : action,
      'attributes': attributes
    };
    next.remove('level');
    if (action.startsWith('heading'))
      next['level'] = int.parse(action.substring(7));
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node, type = node['type'] as String;
    final isText = manuscriptTextTypes.contains(type),
        theme = Theme.of(context);
    final label = type == 'heading'
        ? 'Heading ${node['level'] ?? 1}'
        : type == 'listItem'
            ? 'List item'
            : type == 'pageBreak'
                ? 'Page break'
                : '${type[0].toUpperCase()}${type.substring(1)}';
    final style = type == 'heading'
        ? (node['level'] == 1
            ? theme.textTheme.headlineMedium
            : theme.textTheme.titleLarge)
        : type == 'quote'
            ? theme.textTheme.bodyLarge?.copyWith(fontStyle: FontStyle.italic)
            : theme.textTheme.bodyLarge;
    return Card(
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(
            padding: const EdgeInsets.all(12),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(label, style: theme.textTheme.labelLarge)),
                if (widget.editable)
                  PopupMenuButton<String>(
                      tooltip: 'Block options',
                      onSelected: _action,
                      itemBuilder: (_) => [
                            if (isText) ...[
                              const PopupMenuItem(
                                  value: 'paragraph', child: Text('Paragraph')),
                              const PopupMenuItem(
                                  value: 'heading1', child: Text('Heading 1')),
                              const PopupMenuItem(
                                  value: 'heading2', child: Text('Heading 2')),
                              const PopupMenuItem(
                                  value: 'quote', child: Text('Quote')),
                              const PopupMenuItem(
                                  value: 'bullet',
                                  child: Text('Bullet list item')),
                              const PopupMenuItem(
                                  value: 'numbered',
                                  child: Text('Numbered list item')),
                            ],
                            const PopupMenuItem(
                                value: 'up', child: Text('Move up')),
                            const PopupMenuItem(
                                value: 'down', child: Text('Move down')),
                            const PopupMenuItem(
                                value: 'delete', child: Text('Remove block')),
                          ]),
              ]),
              if (isText) ...[
                TextField(
                    key: ValueKey('text-${node['id']}'),
                    controller: _controller,
                    readOnly: !widget.editable,
                    inputFormatters: [
                      TextInputFormatter.withFunction((oldValue, nextValue) {
                        try {
                          widget.validateNode(replaceManuscriptText(
                              _controller.node, nextValue.text));
                          return nextValue;
                        } on ApiError catch (error) {
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                              content: Text(
                                  '${error.message} The new input was not accepted.')));
                          return oldValue;
                        }
                      })
                    ],
                    maxLines: null,
                    style: style,
                    keyboardType: TextInputType.multiline,
                    decoration: InputDecoration(
                        labelText: '$label text',
                        border: const OutlineInputBorder())),
                if (widget.editable)
                  Wrap(children: [
                    for (final mark in [
                      'bold',
                      'italic',
                      'underline',
                      'strike',
                      'code'
                    ])
                      TextButton(
                          onPressed: () => _format(mark),
                          child: Text(
                              '${mark[0].toUpperCase()}${mark.substring(1)}')),
                  ]),
              ] else if (type == 'image') ...[
                if (widget.artwork != null)
                  PrivateArtworkPreview(artwork: widget.artwork!, node: node)
                else
                  const Icon(Icons.image_outlined,
                      semanticLabel: 'Preserved manuscript artwork'),
                Text(node['altText'] as String? ??
                    'Artwork retained in this chapter'),
                if (node['caption'] is String) Text(node['caption'] as String),
                Text(
                    'Pinned artwork version ${node['assetVersionNumber'] ?? 'not recorded'} · original file retained'),
                if (widget.editable && widget.artwork != null)
                  TextButton(
                      onPressed: widget.onEditArtwork,
                      child: const Text('Artwork settings')),
              ] else if (type == 'table') ...[
                SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: SelectableText((node['rows'] as List? ?? [])
                        .take(20)
                        .map((row) => (row as List)
                            .map((cell) => (cell as String).length > 200
                                ? '${cell.substring(0, 200)}…'
                                : cell)
                            .join(' | '))
                        .join('\n'))),
                Text(
                    'Preview: first 20 rows of ${(node['rows'] as List? ?? []).length}. All cells and formatting are retained.'),
                if (widget.onEditTable != null)
                  TextButton(
                      onPressed: widget.onEditTable,
                      child: Text(widget.editable
                          ? 'Edit table'
                          : 'View all table rows')),
              ] else if (type == 'pageBreak' || type == 'separator')
                const Divider()
              else
                Text(node['text'] as String? ??
                    'This imported block is preserved unchanged.'),
            ])));
  }
}

class _RichManuscriptController extends TextEditingController {
  _RichManuscriptController(this.node)
      : super(text: node['text'] as String? ?? '');
  Map<String, dynamic> node;
  @override
  TextSpan buildTextSpan(
      {required BuildContext context,
      TextStyle? style,
      required bool withComposing}) {
    if (withComposing &&
        value.composing.isValid &&
        !value.composing.isCollapsed) {
      return super.buildTextSpan(
          context: context, style: style, withComposing: withComposing);
    }
    return TextSpan(
        style: style,
        children: manuscriptRuns(node).map((run) {
          final marks = (run['marks'] is List ? run['marks'] as List : const [])
              .whereType<Map>()
              .map((mark) => mark['type'])
              .toSet();
          return TextSpan(
              text: run['type'] == 'hardBreak' ? '\n' : run['text'] as String,
              style: TextStyle(
                  fontWeight: marks.contains('bold') ? FontWeight.bold : null,
                  fontStyle: marks.contains('italic') ? FontStyle.italic : null,
                  fontFamily: marks.contains('code') ? 'monospace' : null,
                  decoration: TextDecoration.combine([
                    if (marks.contains('underline')) TextDecoration.underline,
                    if (marks.contains('strike')) TextDecoration.lineThrough
                  ])));
        }).toList());
  }
}
