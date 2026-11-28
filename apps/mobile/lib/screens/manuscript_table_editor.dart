import 'package:flutter/material.dart' hide TableCell;
import 'package:flutter/services.dart';

import '../manuscript_table.dart';
import '../models.dart';

/// Edits immediately enter the existing secure manuscript draft, not the server.
class ManuscriptTableEditor extends StatefulWidget {
  const ManuscriptTableEditor(
      {super.key,
      required this.node,
      required this.onChanged,
      required this.validateNode,
      this.readOnly = false});
  final Map<String, dynamic> node;
  final ValueChanged<Map<String, dynamic>> onChanged, validateNode;
  final bool readOnly;
  @override
  State<ManuscriptTableEditor> createState() => _ManuscriptTableEditorState();
}

class _ManuscriptTableEditorState extends State<ManuscriptTableEditor> {
  late Map<String, dynamic> _node = widget.node;
  final _history = <Map<String, dynamic>>[];
  final _text = TextEditingController(),
      _jump = TextEditingController(),
      _headers = TextEditingController();
  TableCell? _first, _last;
  int _page = 0;
  String? _error;
  String _status =
      'Changes enter your local manuscript draft. Save the chapter to sync online.';
  bool _typing = false;

  @override
  void initState() {
    super.initState();
    _headers.text = '${tableHeaderRows(_node)}';
  }

  @override
  void dispose() {
    _text.dispose();
    _jump.dispose();
    _headers.dispose();
    super.dispose();
  }

  void _apply(Map<String, dynamic> Function() change,
      {bool typing = false, String? status}) {
    if (widget.readOnly) return;
    try {
      final next = change();
      widget.validateNode(next);
      widget.onChanged(next);
      if (!typing || !_typing) {
        // Bound in-screen undo; the chapter's saved versions remain separate.
        if (_history.length == 20) _history.removeAt(0);
        _history.add(_node);
      }
      setState(() {
        _node = next;
        _typing = typing;
        _error = null;
        if (status != null) _status = status;
      });
      _headers.text = '${tableHeaderRows(_node)}';
    } on ApiError catch (error) {
      setState(() => _error = error.message);
    }
  }

  void _select(TableCell cell) {
    final anchor = tableAnchor(tableSpans(_node), cell),
        rows = manuscriptTableRows(_node)!;
    setState(() {
      if (_first == null || _last != null || widget.readOnly) {
        _first = anchor;
        _last = null;
      } else {
        _last = anchor;
      }
      _typing = false;
      _error = null;
      _text.text = rows[_first!.row][_first!.col];
    });
  }

  Future<void> _remove(bool row) async {
    final cell = _first;
    if (cell == null) return;
    final allowed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
                title: Text(
                    'Remove ${row ? 'row ${cell.row + 1}' : 'column ${cell.col + 1}'}?'),
                content: const Text(
                    'This removes its cell contents from the local draft. You can undo here; saved chapter versions remain unchanged until you save.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('Cancel')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('Remove'))
                ]));
    if (allowed != true || !mounted) return;
    _apply(
        () => removeTableDimension(_node, row ? cell.row : cell.col, row: row),
        status: 'Removed from the local draft. Undo restores the cells.');
    if (_error == null)
      setState(() {
        _first = null;
        _last = null;
        _page = 0;
      });
  }

  Future<void> _reviewLayout() async {
    final allowed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
                title: const Text('Use separate cells?'),
                content: const Text(
                    'The saved merge map does not match this grid. Remove only that stale merge map? All cell text and other table properties are kept. Review the grid before saving.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('Cancel')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('Use separate cells'))
                ]));
    if (allowed == true && mounted)
      _apply(() => resetTableLayout(_node),
          status: 'Merge map removed after review. All cell text retained.');
  }

  @override
  Widget build(BuildContext context) {
    final rows = manuscriptTableRows(_node),
        spans = tableSpans(_node),
        theme = Theme.of(context);
    final stale = staleTableLayout(_node), headers = tableHeaderRows(_node);
    final selected = _first;
    final page = rows == null || rows.isEmpty
        ? 0
        : _page.clamp(0, (rows.length - 1) ~/ 10);
    final visible = rows?.skip(page * 10).take(10).toList() ?? <List<String>>[];
    return Scaffold(
      appBar: AppBar(
          title: Text(widget.readOnly ? 'Table' : 'Table editor'),
          actions: [
            IconButton(
                tooltip: 'Undo table change',
                onPressed: widget.readOnly || _history.isEmpty
                    ? null
                    : () {
                        final prior = _history.last;
                        try {
                          widget.validateNode(prior);
                          widget.onChanged(prior);
                          setState(() {
                            _node = prior;
                            _history.removeLast();
                            _first = null;
                            _last = null;
                            _typing = false;
                            _error = null;
                            _status = 'Table change undone in the local draft.';
                          });
                          _headers.text = '${tableHeaderRows(_node)}';
                        } on ApiError catch (error) {
                          setState(() => _error = error.message);
                        }
                      },
                icon: const Icon(Icons.undo))
          ]),
      body: SafeArea(
          child: ListView(padding: const EdgeInsets.all(16), children: [
        Text(
            '${rows?.length ?? 0} rows · $headers header rows · ${spans.length} merged cells',
            style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        Semantics(
            liveRegion: true,
            child: Text(
                _error ??
                    (widget.readOnly
                        ? 'Read-only table. Select a cell to read its full text.'
                        : _status),
                style: TextStyle(
                    color: _error == null ? null : theme.colorScheme.error))),
        if (rows == null) ...[
          const SizedBox(height: 16),
          const Text(
              'The text was changed outside this grid. The latest text is preserved below; no stale cells can overwrite it.'),
          SelectableText(_node['text'] as String? ?? '')
        ] else ...[
          if (stale) ...[
            const Text(
                'The merged layout no longer matches this grid. Review all cells before editing.'),
            if (!widget.readOnly)
              TextButton(
                  onPressed: _reviewLayout,
                  child: const Text('Review as separate cells'))
          ],
          if (!widget.readOnly)
            Wrap(spacing: 8, runSpacing: 8, children: [
              OutlinedButton(
                  onPressed: stale || rows.length >= 2000
                      ? null
                      : () => _apply(() => addTableDimension(_node, row: true)),
                  child: const Text('Add row')),
              OutlinedButton(
                  onPressed: stale || rows.any((row) => row.length >= 100)
                      ? null
                      : () =>
                          _apply(() => addTableDimension(_node, row: false)),
                  child: const Text('Add column')),
              if (selected != null) ...[
                TextButton(
                    onPressed: stale ? null : () => _remove(true),
                    child: const Text('Remove selected row')),
                TextButton(
                    onPressed: stale ? null : () => _remove(false),
                    child: const Text('Remove selected column')),
              ],
            ]),
          const SizedBox(height: 12),
          if (!widget.readOnly)
            Row(children: [
              Expanded(
                  child: TextField(
                      controller: _headers,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                          labelText: 'Header rows',
                          border: OutlineInputBorder()))),
              const SizedBox(width: 8),
              TextButton(
                  onPressed: stale
                      ? null
                      : () => _apply(() => setTableHeaders(
                          _node, int.tryParse(_headers.text) ?? -1)),
                  child: const Text('Set headers'))
            ]),
          const SizedBox(height: 12),
          if (!widget.readOnly)
            const Text(
                'Select one cell to edit. Select a second corner to merge a rectangle. Covered cells select their merged anchor.'),
          if (!widget.readOnly)
            Wrap(spacing: 8, children: [
              TextButton(
                  onPressed: _first != null && _last != null && !stale
                      ? () {
                          final a = _first!, b = _last!;
                          _apply(() => mergeTableCells(_node, a, b),
                              status:
                                  'Merged in reading order. All text is retained in the first cell.');
                          if (_error == null)
                            setState(() {
                              _first = null;
                              _last = null;
                            });
                        }
                      : null,
                  child: const Text('Merge selected')),
              TextButton(
                  onPressed: selected != null &&
                          !stale &&
                          spans.any((s) =>
                              s.row == selected.row && s.col == selected.col)
                      ? () {
                          _apply(() => splitTableCell(_node, selected),
                              status:
                                  'Cell split. Text remains in its first cell.');
                        }
                      : null,
                  child: const Text('Split selected cell')),
              if (selected != null)
                TextButton(
                    onPressed: () => setState(() {
                          _first = null;
                          _last = null;
                          _typing = false;
                        }),
                    child: const Text('Clear selection')),
            ]),
          if (selected != null && (!stale || widget.readOnly)) ...[
            Text(
                'Selected row ${selected.row + 1}, column ${selected.col + 1}${_last == null ? '' : ' through row ${_last!.row + 1}, column ${_last!.col + 1}'}'),
            if (_last == null)
              Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: TextField(
                      key: const ValueKey('table-cell-text'),
                      controller: _text,
                      readOnly: widget.readOnly,
                      inputFormatters: [
                        TextInputFormatter.withFunction((oldValue, nextValue) {
                          try {
                            widget.validateNode(
                                editTableCell(_node, selected, nextValue.text));
                            return nextValue;
                          } on ApiError catch (error) {
                            setState(() => _error =
                                '${error.message} The new input was not accepted.');
                            return oldValue;
                          }
                        })
                      ],
                      maxLines: null,
                      maxLength: 100000,
                      decoration: const InputDecoration(
                          labelText: 'Cell text', border: OutlineInputBorder()),
                      onChanged: (value) => _apply(
                          () => editTableCell(_node, selected, value),
                          typing: true))),
          ],
          const SizedBox(height: 12),
          for (final (offset, cells) in visible.indexed) ...[
            Text(
                'Row ${page * 10 + offset + 1}${page * 10 + offset < headers ? ' · header' : ''}',
                style: theme.textTheme.labelLarge),
            SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [
                  for (var c = 0; c < cells.length; c++)
                    Padding(
                        padding:
                            const EdgeInsets.only(right: 6, top: 6, bottom: 12),
                        child: SizedBox(
                            width: 144,
                            child: OutlinedButton(
                                style: OutlinedButton.styleFrom(
                                    minimumSize: const Size(144, 72),
                                    backgroundColor: selected ==
                                            (row: page * 10 + offset, col: c)
                                        ? theme.colorScheme.secondaryContainer
                                        : null),
                                onPressed: stale && !widget.readOnly
                                    ? null
                                    : () => _select(
                                        (row: page * 10 + offset, col: c)),
                                child: Semantics(
                                    label:
                                        'Select row ${page * 10 + offset + 1}, column ${c + 1}',
                                    child: Text(
                                        tableAnchor(spans, (
                                                  row: page * 10 + offset,
                                                  col: c
                                                )) !=
                                                (
                                                  row: page * 10 + offset,
                                                  col: c
                                                )
                                            ? 'Merged cell'
                                            : cells[c].isEmpty
                                                ? 'Empty cell'
                                                : cells[c],
                                        maxLines: 3,
                                        overflow: TextOverflow.ellipsis))))),
                ])),
          ],
          Wrap(alignment: WrapAlignment.spaceBetween, spacing: 8, children: [
            TextButton(
                onPressed:
                    page > 0 ? () => setState(() => _page = page - 1) : null,
                child: const Text('Previous rows')),
            Text(
                'Rows ${rows.isEmpty ? 0 : page * 10 + 1}–${(page * 10 + 10).clamp(0, rows.length)} of ${rows.length}'),
            TextButton(
                onPressed: (page + 1) * 10 < rows.length
                    ? () => setState(() => _page = page + 1)
                    : null,
                child: const Text('Next rows')),
          ]),
          Row(children: [
            Expanded(
                child: TextField(
                    controller: _jump,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                        labelText: 'Go to row', border: OutlineInputBorder()))),
            TextButton(
                onPressed: () {
                  final row = int.tryParse(_jump.text);
                  setState(() {
                    if (row == null || row < 1 || row > rows.length) {
                      _error = 'Choose an existing row.';
                    } else {
                      _page = (row - 1) ~/ 10;
                      _error = null;
                    }
                  });
                },
                child: const Text('Go'))
          ]),
        ],
        const SizedBox(height: 20),
        FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Return to manuscript')),
      ])),
    );
  }
}
