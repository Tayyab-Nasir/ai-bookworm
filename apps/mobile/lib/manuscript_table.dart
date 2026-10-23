import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'chapter_document.dart';

typedef TableCell = ({int row, int col});
typedef TableSpan = ({int row, int col, int rowspan, int colspan});

String tableText(List<List<String>> rows) =>
    rows.map((row) => row.join('\t')).join('\n');
String tableGridHash(List<List<String>> rows) =>
    'v2:${sha256.convert(utf8.encode(jsonEncode(rows)))}';

/// Same grid/source rules as the web editor and canonical rendering services.
List<List<String>>? manuscriptTableRows(Map<String, dynamic> node) {
  final rows = node['rows'];
  if (node['type'] != 'table' ||
      rows is! List ||
      rows.length > 2000 ||
      rows.any((row) =>
          row is! List ||
          row.length > 100 ||
          row.any((cell) => cell is! String || cell.length > 100000)))
    return null;
  final result =
      rows.map((row) => (row as List).cast<String>().toList()).toList();
  return node['text'] == null || node['text'] == tableText(result)
      ? result
      : null;
}

int tableHeaderRows(Map<String, dynamic> node) {
  final rows = manuscriptTableRows(node),
      count = (node['attributes'] as Map?)?['tableHeaderRows'];
  return rows != null && count is int && count >= 0 && count <= rows.length
      ? count
      : 0;
}

List<TableSpan> tableSpans(Map<String, dynamic> node) {
  final rows = manuscriptTableRows(node), attrs = node['attributes'] as Map?;
  final value = attrs?['tableSpans'];
  if (rows == null ||
      value is! List ||
      value.length > rows.fold<int>(0, (n, row) => n + row.length) ||
      !{
        tableGridHash(rows),
        sha256.convert(utf8.encode(tableText(rows))).toString()
      }.contains(attrs?['tableSpanSource'])) return [];
  final occupied = <TableCell>{}, result = <TableSpan>[];
  final headers = tableHeaderRows(node);
  for (final entry in value) {
    if (entry is! Map ||
        !['row', 'col', 'rowspan', 'colspan'].every((key) => entry[key] is int))
      return [];
    final span = (
      row: entry['row'] as int,
      col: entry['col'] as int,
      rowspan: entry['rowspan'] as int,
      colspan: entry['colspan'] as int
    );
    if (span.row < 0 ||
        span.col < 0 ||
        span.rowspan < 1 ||
        span.colspan < 1 ||
        span.rowspan * span.colspan < 2 ||
        span.row + span.rowspan > rows.length ||
        (span.row < headers && headers < span.row + span.rowspan)) return [];
    for (var r = span.row; r < span.row + span.rowspan; r++) {
      if (span.col + span.colspan > rows[r].length) return [];
      for (var c = span.col; c < span.col + span.colspan; c++) {
        if (!occupied.add((row: r, col: c)) ||
            ((r != span.row || c != span.col) && rows[r][c].isNotEmpty))
          return [];
      }
    }
    result.add(span);
  }
  return result
    ..sort((a, b) =>
        a.row != b.row ? a.row.compareTo(b.row) : a.col.compareTo(b.col));
}

bool staleTableLayout(Map<String, dynamic> node) {
  final value = (node['attributes'] as Map?)?['tableSpans'];
  return value != null &&
      (value is! List || value.isNotEmpty && tableSpans(node).isEmpty);
}

TableCell tableAnchor(List<TableSpan> spans, TableCell cell) {
  for (final span in spans) {
    if (cell.row >= span.row &&
        cell.row < span.row + span.rowspan &&
        cell.col >= span.col &&
        cell.col < span.col + span.colspan)
      return (row: span.row, col: span.col);
  }
  return cell;
}

List<List<String>> _rows(Map<String, dynamic> node) {
  final rows = manuscriptTableRows(node);
  if (rows == null)
    throw manuscriptError(
        'The table text and grid disagree. The original is preserved; review it before editing.');
  if (staleTableLayout(node))
    throw manuscriptError(
        'Review the unmatched merged layout before editing cells.');
  return rows;
}

Map<String, dynamic> _layout(Map<String, dynamic> node, List<List<String>> rows,
    List<TableSpan> spans, int headers) {
  if (rows.length > 2000 ||
      rows.any((row) =>
          row.length > 100 || row.any((cell) => cell.length > 100000))) {
    throw manuscriptError(
        'This table exceeds the supported size. No cells were changed.');
  }
  final attrs = {...?node['attributes'] as Map<String, dynamic>?}
    ..remove('richText')
    ..remove('tableSpans')
    ..remove('tableSpanSource');
  return {
    ...node,
    'rows': rows,
    'text': tableText(rows),
    'attributes': {
      ...attrs,
      'tableHeaderRows': headers.clamp(0, rows.length),
      if (spans.isNotEmpty)
        'tableSpans': spans
            .map((s) => {
                  'row': s.row,
                  'col': s.col,
                  'rowspan': s.rowspan,
                  'colspan': s.colspan
                })
            .toList(),
      if (spans.isNotEmpty) 'tableSpanSource': tableGridHash(rows),
    }
  };
}

Map<String, dynamic> resetTableLayout(Map<String, dynamic> node) {
  final rows = manuscriptTableRows(node);
  if (rows == null)
    throw manuscriptError(
        'The original table text is preserved. Resolve the text/grid difference first.');
  return _layout(node, rows, [], tableHeaderRows(node));
}

Map<String, dynamic> editTableCell(
    Map<String, dynamic> node, TableCell cell, String text) {
  final rows = _rows(node), spans = tableSpans(node);
  if (cell.row < 0 ||
      cell.row >= rows.length ||
      cell.col < 0 ||
      cell.col >= rows[cell.row].length ||
      tableAnchor(spans, cell) != cell) {
    throw manuscriptError('Choose an editable cell inside this table.');
  }
  rows[cell.row][cell.col] = text;
  return _layout(node, rows, spans, tableHeaderRows(node));
}

Map<String, dynamic> setTableHeaders(Map<String, dynamic> node, int count) {
  final rows = _rows(node), spans = tableSpans(node);
  if (count < 0 || count > rows.length)
    throw manuscriptError('Choose a valid number of header rows.');
  if (spans.any((s) => s.row < count && count < s.row + s.rowspan)) {
    throw manuscriptError(
        'Split the cell spanning header and body before changing header rows.');
  }
  return _layout(node, rows, spans, count);
}

Map<String, dynamic> mergeTableCells(
    Map<String, dynamic> node, TableCell first, TableCell last) {
  final rows = _rows(node),
      spans = tableSpans(node),
      headers = tableHeaderRows(node);
  TableSpan extent(TableCell cell) =>
      spans.where((s) => s.row == cell.row && s.col == cell.col).firstOrNull ??
      (row: cell.row, col: cell.col, rowspan: 1, colspan: 1);
  final a = extent(tableAnchor(spans, first)),
      b = extent(tableAnchor(spans, last));
  final top = a.row < b.row ? a.row : b.row,
      left = a.col < b.col ? a.col : b.col;
  final bottom = a.row + a.rowspan > b.row + b.rowspan
      ? a.row + a.rowspan
      : b.row + b.rowspan;
  final right = a.col + a.colspan > b.col + b.colspan
      ? a.col + a.colspan
      : b.col + b.colspan;
  if (top < 0 ||
      left < 0 ||
      bottom > rows.length ||
      rows.skip(top).take(bottom - top).any((row) => right > row.length) ||
      (bottom - top) * (right - left) < 2)
    throw manuscriptError('Select at least two cells inside this table.');
  if (top < headers && headers < bottom)
    throw manuscriptError('Header and body cells cannot be merged together.');
  final retained = <TableSpan>[];
  for (final span in spans) {
    final overlaps = span.row < bottom &&
        span.row + span.rowspan > top &&
        span.col < right &&
        span.col + span.colspan > left;
    if (overlaps &&
        !(span.row >= top &&
            span.row + span.rowspan <= bottom &&
            span.col >= left &&
            span.col + span.colspan <= right)) {
      throw manuscriptError('Select whole merged cells, or split them first.');
    }
    if (!overlaps) retained.add(span);
  }
  final text = <String>[];
  for (var r = top; r < bottom; r++) {
    for (var c = left; c < right; c++) {
      if (rows[r][c].isNotEmpty) text.add(rows[r][c]);
      rows[r][c] = '';
    }
  }
  rows[top][left] = text.join('\n');
  retained
      .add((row: top, col: left, rowspan: bottom - top, colspan: right - left));
  return _layout(node, rows, retained, headers);
}

Map<String, dynamic> splitTableCell(
        Map<String, dynamic> node, TableCell cell) =>
    _layout(
        node,
        _rows(node),
        tableSpans(node)
            .where((s) => s.row != cell.row || s.col != cell.col)
            .toList(),
        tableHeaderRows(node));

Map<String, dynamic> addTableDimension(Map<String, dynamic> node,
    {required bool row}) {
  final rows = _rows(node), spans = tableSpans(node);
  final columns =
      rows.fold<int>(0, (n, cells) => cells.length > n ? cells.length : n);
  if (row) {
    rows.add(List.filled(columns == 0 ? 1 : columns, ''));
  } else {
    if (rows.isEmpty) rows.add([]);
    for (final cells in rows) {
      while (cells.length < columns) {
        cells.add('');
      }
      cells.add('');
    }
  }
  return _layout(node, rows, spans, tableHeaderRows(node));
}

Map<String, dynamic> removeTableDimension(Map<String, dynamic> node, int index,
    {required bool row}) {
  final rows = _rows(node), spans = tableSpans(node);
  final count = row
      ? rows.length
      : rows.fold<int>(0, (n, cells) => cells.length > n ? cells.length : n);
  if (index < 0 || index >= count)
    throw manuscriptError('Choose a row or column inside this table.');
  if (spans.any((s) => row
      ? s.row <= index && index < s.row + s.rowspan
      : s.col <= index && index < s.col + s.colspan)) {
    throw manuscriptError(
        'Split merged cells touching this row or column before removing it.');
  }
  if (row) {
    rows.removeAt(index);
  } else {
    for (final cells in rows) {
      if (index < cells.length) cells.removeAt(index);
    }
  }
  final shifted = spans
      .map((s) => (
            row: s.row - (row && s.row > index ? 1 : 0),
            col: s.col - (!row && s.col > index ? 1 : 0),
            rowspan: s.rowspan,
            colspan: s.colspan
          ))
      .toList();
  final headers = tableHeaderRows(node);
  return _layout(
      node, rows, shifted, headers - (row && index < headers ? 1 : 0));
}
