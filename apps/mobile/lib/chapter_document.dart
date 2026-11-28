import 'dart:convert';

import 'models.dart';

const manuscriptTextTypes = {
  'paragraph',
  'heading',
  'quote',
  'listItem',
  'caption',
  'footnote'
};
const manuscriptNodeTypes = {
  ...manuscriptTextTypes,
  'list',
  'image',
  'pageBreak',
  'table',
  'separator'
};
const manuscriptEditRoles = {
  'owner',
  'admin',
  'editor',
  'writer',
  'illustrator',
  'designer'
};

ApiError manuscriptError(String message) =>
    ApiError(422, 'manuscript', message, '');

bool sameJson(Object? left, Object? right) {
  if (left is Map && right is Map) {
    return left.length == right.length &&
        left.keys.every(
            (key) => right.containsKey(key) && sameJson(left[key], right[key]));
  }
  if (left is List && right is List) {
    return left.length == right.length &&
        Iterable<int>.generate(left.length)
            .every((i) => sameJson(left[i], right[i]));
  }
  return left == right;
}

dynamic _freeze(dynamic value) => switch (value) {
      Map<String, dynamic> map => Map<String, dynamic>.unmodifiable(
          map.map((key, value) => MapEntry(key, _freeze(value)))),
      List list => List<dynamic>.unmodifiable(list.map(_freeze)),
      _ => value,
    };

/// Unknown JSON fields are retained, including artwork pins and imported styles.
class ChapterDocument {
  ChapterDocument._(this.chapterId, this.version, this.nodes);
  final String chapterId;
  final int version;
  final List<Map<String, dynamic>> nodes;

  factory ChapterDocument.parse(Object? value, String chapterId) {
    if (value is! Map<String, dynamic> ||
        value['chapterId'] != chapterId ||
        value['version'] is! int ||
        (value['version'] as int) < 0 ||
        (value['version'] as int) > 2147483647 ||
        value['nodes'] is! List) {
      throw manuscriptError(
          'The manuscript response is invalid. Your draft was not replaced.');
    }
    final nodes = value['nodes'] as List;
    final ids = <String>{};
    if (nodes.length > 20000 ||
        utf8.encode(jsonEncode(nodes)).length > 4000000) {
      throw manuscriptError(
          'This chapter exceeds the supported document size. No content was discarded.');
    }
    for (final node in nodes) {
      if (node is! Map<String, dynamic> ||
          node['id'] is! String ||
          (node['id'] as String).isEmpty ||
          !ids.add(node['id'] as String) ||
          !manuscriptNodeTypes.contains(node['type']) ||
          (node['text'] != null && node['text'] is! String) ||
          (node['attributes'] != null &&
              node['attributes'] is! Map<String, dynamic>) ||
          (node['assetId'] != null &&
              (node['assetId'] is! String ||
                  !RegExp(r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')
                      .hasMatch(node['assetId'] as String))) ||
          (node['assetVersionNumber'] != null &&
              (node['assetVersionNumber'] is! int ||
                  (node['assetVersionNumber'] as int) < 1)) ||
          (node['altText'] != null &&
              (node['altText'] is! String ||
                  (node['altText'] as String).length > 1000)) ||
          (node['caption'] != null &&
              (node['caption'] is! String ||
                  (node['caption'] as String).length > 2000)) ||
          (node['level'] != null &&
              (node['level'] is! int ||
                  (node['level'] as int) < 1 ||
                  (node['level'] as int) > 6)) ||
          (node['rows'] != null &&
              (node['rows'] is! List ||
                  (node['rows'] as List).length > 2000 ||
                  (node['rows'] as List).any((row) =>
                      row is! List ||
                      row.length > 100 ||
                      row.any((cell) =>
                          cell is! String || cell.length > 100000))))) {
        throw manuscriptError(
            'This chapter contains an unsupported block. The original is preserved.');
      }
    }
    return ChapterDocument._(
        chapterId,
        value['version'] as int,
        List.unmodifiable(
            nodes.map((node) => _freeze(node) as Map<String, dynamic>)));
  }

  Map<String, dynamic> toJson() =>
      {'chapterId': chapterId, 'version': version, 'nodes': nodes};
  ChapterDocument withNodes(List<Map<String, dynamic>> next) =>
      ChapterDocument.parse({...toJson(), 'nodes': next}, chapterId);

  String get plainText => nodes
      .expand((node) {
        final text = node['text'] as String? ??
            (node['type'] == 'table'
                ? (node['rows'] as List? ?? [])
                    .map((row) => (row as List).join('\t'))
                    .join('\n')
                : '');
        final caption =
            node['type'] == 'image' ? node['caption'] as String? ?? '' : '';
        return [text, if (caption.isNotEmpty && caption != text) caption];
      })
      .where((text) => text.isNotEmpty)
      .join('\n\n');
}

List<Map<String, dynamic>> _plainRuns(String text) => [
      for (final (index, line) in text.split('\n').indexed) ...[
        if (index != 0) {'type': 'hardBreak'},
        if (line.isNotEmpty) {'type': 'text', 'text': line},
      ]
    ];

String _runText(Map<String, dynamic> run) =>
    run['type'] == 'hardBreak' ? '\n' : run['text'] as String;

/// Mirrors canonical text precedence in packages/book-model/src/rich-text.ts.
List<Map<String, dynamic>> manuscriptRuns(Map<String, dynamic> node) {
  final text = node['text'] as String? ?? '';
  final runs = (node['attributes'] as Map?)?['richText'];
  if (runs is List &&
      runs.every((run) =>
          run is Map<String, dynamic> &&
          (run['type'] == 'hardBreak' ||
              run['type'] == 'text' && run['text'] is String))) {
    final typed = runs.cast<Map<String, dynamic>>();
    if (typed.map(_runText).join() == text) return typed;
  }
  return _plainRuns(text);
}

bool _splitsSurrogate(String text, int offset) =>
    offset > 0 &&
    offset < text.length &&
    text.codeUnitAt(offset - 1) >= 0xd800 &&
    text.codeUnitAt(offset - 1) <= 0xdbff &&
    text.codeUnitAt(offset) >= 0xdc00 &&
    text.codeUnitAt(offset) <= 0xdfff;

List<Map<String, dynamic>> _sliceRuns(
    List<Map<String, dynamic>> runs, int start, int end) {
  var offset = 0;
  final result = <Map<String, dynamic>>[];
  for (final run in runs) {
    final text = _runText(run);
    final value = text.substring((start - offset).clamp(0, text.length),
        (end - offset).clamp(0, text.length));
    offset += text.length;
    if (value.isNotEmpty)
      result
          .add(run['type'] == 'hardBreak' ? {...run} : {...run, 'text': value});
  }
  return result;
}

Map<String, dynamic> replaceManuscriptText(
    Map<String, dynamic> node, String next) {
  final old = node['text'] as String? ?? '';
  if (old == next) return node;
  var from = 0, oldEnd = old.length, newEnd = next.length;
  while (from < oldEnd &&
      from < newEnd &&
      old.codeUnitAt(from) == next.codeUnitAt(from)) {
    from++;
  }
  if (_splitsSurrogate(old, from) || _splitsSurrogate(next, from)) from--;
  while (oldEnd > from &&
      newEnd > from &&
      old.codeUnitAt(oldEnd - 1) == next.codeUnitAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  if (_splitsSurrogate(old, oldEnd) || _splitsSurrogate(next, newEnd)) {
    oldEnd++;
    newEnd++;
  }
  final runs = manuscriptRuns(node);
  var offset = 0;
  Map<String, dynamic>? anchor;
  for (final run in runs) {
    offset += _runText(run).length;
    anchor = run;
    if (offset > from) break;
  }
  final inserted = _plainRuns(next.substring(from, newEnd)).map((run) =>
      run['type'] == 'text' &&
              anchor?['type'] == 'text' &&
              anchor?['marks'] != null
          ? {...run, 'marks': anchor!['marks']}
          : run);
  return {
    ...node,
    'text': next,
    'attributes': {
      ...?node['attributes'] as Map<String, dynamic>?,
      'richText': [
        ..._sliceRuns(runs, 0, from),
        ...inserted,
        ..._sliceRuns(runs, oldEnd, old.length)
      ]
    }
  };
}

Map<String, dynamic> toggleManuscriptMark(
    Map<String, dynamic> node, int start, int end, String mark) {
  final text = node['text'] as String? ?? '';
  if (!{'bold', 'italic', 'underline', 'strike', 'code'}.contains(mark) ||
      start < 0 ||
      start >= end ||
      end > text.length ||
      _splitsSurrogate(text, start) ||
      _splitsSurrogate(text, end)) {
    throw manuscriptError('Select complete text before formatting.');
  }
  final runs = manuscriptRuns(node),
      selected = _sliceRuns(manuscriptRuns(node), start, end);
  bool marked(Map<String, dynamic> run) =>
      (run['marks'] is List ? run['marks'] as List : const [])
          .any((value) => value is Map && value['type'] == mark);
  final remove = selected.where((run) => run['type'] == 'text').every(marked);
  final formatted = selected.map((run) => run['type'] != 'text'
      ? run
      : {
          ...run,
          'marks': [
            for (final value
                in run['marks'] is List ? run['marks'] as List : const [])
              if (value is! Map || value['type'] != mark) value,
            if (!remove) {'type': mark},
          ]
        });
  return {
    ...node,
    'attributes': {
      ...?node['attributes'] as Map<String, dynamic>?,
      'richText': [
        ..._sliceRuns(runs, 0, start),
        ...formatted,
        ..._sliceRuns(runs, end, text.length)
      ]
    }
  };
}

/// Three-way block merge. Never guesses when both sides changed the same block/order.
List<String> manuscriptConflicts(
    ChapterDocument base, ChapterDocument local, ChapterDocument remote) {
  final originals = {for (final node in base.nodes) node['id']: node};
  final ours = {for (final node in local.nodes) node['id']: node};
  final theirs = {for (final node in remote.nodes) node['id']: node};
  return [
    for (final id in {...originals.keys, ...ours.keys, ...theirs.keys})
      if (!sameJson(ours[id], originals[id]) &&
          !sameJson(theirs[id], originals[id]) &&
          !sameJson(ours[id], theirs[id]))
        id as String
  ];
}

bool manuscriptOrderConflict(
    ChapterDocument base, ChapterDocument local, ChapterDocument remote) {
  final original = base.nodes.map((node) => node['id']).toList();
  final ours = local.nodes.map((node) => node['id']).toList();
  final theirs = remote.nodes.map((node) => node['id']).toList();
  return !sameJson(original, ours) &&
      !sameJson(original, theirs) &&
      !sameJson(ours, theirs);
}

List<Map<String, dynamic>> mergeManuscript(
    ChapterDocument base, ChapterDocument local, ChapterDocument remote,
    {Map<String, bool> localChoices = const {}, bool? localOrder}) {
  final baseIds = base.nodes.map((node) => node['id']).toList();
  final localIds = local.nodes.map((node) => node['id']).toList();
  final remoteIds = remote.nodes.map((node) => node['id']).toList();
  if (!sameJson(baseIds, localIds) &&
      !sameJson(baseIds, remoteIds) &&
      !sameJson(localIds, remoteIds) &&
      localOrder == null) {
    throw manuscriptError(
        'Both copies changed block order or structure. Keep your draft and resolve the differences manually.');
  }
  final originals = {for (final node in base.nodes) node['id']: node};
  final ours = {for (final node in local.nodes) node['id']: node};
  final theirs = {for (final node in remote.nodes) node['id']: node};
  final merged = <String, Map<String, dynamic>>{};
  for (final id in {...baseIds, ...localIds, ...remoteIds}) {
    final original = originals[id], own = ours[id], other = theirs[id];
    Map<String, dynamic>? chosen;
    if (sameJson(own, original)) {
      chosen = other;
    } else if (sameJson(other, original) || sameJson(own, other)) {
      chosen = own;
    } else if (localChoices.containsKey(id)) {
      chosen = localChoices[id]! ? own : other;
    } else {
      throw manuscriptError(
          'Block $id changed in both copies. Your draft is preserved; review the differences before replacing anything.');
    }
    if (chosen != null) merged[id as String] = chosen;
  }
  final order = localOrder != null
      ? (localOrder ? localIds : remoteIds)
      : sameJson(localIds, baseIds)
          ? remoteIds
          : localIds;
  // Order choice never silently discards a block explicitly retained above.
  // Retained blocks absent from that order follow it in stable source order.
  return [
    for (final id in {...order, ...remoteIds, ...localIds})
      if (merged[id] != null) merged[id]!
  ];
}
