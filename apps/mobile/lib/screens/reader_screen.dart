import 'package:flutter/material.dart';

import '../api.dart';
import '../auth.dart';
import '../manuscript_draft.dart';
import '../models.dart';
import 'manuscript_editor.dart';

class ReaderScreen extends StatefulWidget {
  const ReaderScreen(
      {super.key,
      required this.auth,
      required this.chapter,
      required this.workspaceId});
  final AuthState auth;
  final Chapter chapter;
  final String workspaceId;
  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  ManuscriptDraft? _editor;
  @override
  void initState() {
    super.initState();
    final api = widget.auth.api, user = widget.auth.user;
    if (api != null &&
        user != null &&
        widget.auth.workspace?.id == widget.workspaceId) {
      _editor = ManuscriptDraft(
          api: api,
          userId: user.id,
          workspaceId: widget.workspaceId,
          bookId: widget.chapter.bookId,
          chapterId: widget.chapter.id);
    }
  }

  @override
  void dispose() {
    _editor?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final editor = _editor;
    if (editor == null)
      return Scaffold(
          appBar: AppBar(title: Text(widget.chapter.title)),
          body: const Center(
              child: Text(
                  'Select the correct workspace before opening this chapter.')));
    return ManuscriptEditor(
        editor: editor,
        title: widget.chapter.title,
        onComments: () => showModalBottomSheet<void>(
            context: context,
            isScrollControlled: true,
            useSafeArea: true,
            builder: (_) => _ChapterComments(
                api: editor.api,
                workspaceId: widget.workspaceId,
                chapterId: widget.chapter.id)));
  }
}

class _ChapterComments extends StatefulWidget {
  const _ChapterComments(
      {required this.api, required this.workspaceId, required this.chapterId});
  final ApiClient api;
  final String workspaceId, chapterId;
  @override
  State<_ChapterComments> createState() => _ChapterCommentsState();
}

class _ChapterCommentsState extends State<_ChapterComments> {
  final _text = TextEditingController();
  List<Map<String, dynamic>> _comments = [];
  bool _busy = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _busy = true);
    try {
      final rows = await widget.api
          .listComments(widget.workspaceId, 'chapter', widget.chapterId);
      if (mounted)
        setState(() {
          _comments = rows;
          _error = null;
        });
    } on Exception {
      if (mounted)
        setState(() => _error =
            'Comments could not be loaded. Your manuscript was not changed.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _post() async {
    final text = _text.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() => _busy = true);
    try {
      await widget.api
          .createComment(widget.workspaceId, 'chapter', widget.chapterId, text);
      if (!mounted) return;
      _text.clear();
      await _load();
    } on Exception {
      if (mounted)
        setState(() => _error =
            'The comment could not be confirmed. Refresh comments before posting again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
      padding: EdgeInsets.fromLTRB(
          16, 16, 16, MediaQuery.viewInsetsOf(context).bottom + 16),
      child: SizedBox(
          height: MediaQuery.sizeOf(context).height * .65,
          child: Column(children: [
            Text('Chapter comments',
                style: Theme.of(context).textTheme.titleLarge),
            if (_busy) const LinearProgressIndicator(),
            if (_error != null) Text(_error!),
            Expanded(
                child: ListView.builder(
                    itemCount: _comments.length,
                    itemBuilder: (_, index) => ListTile(
                        leading: const Icon(Icons.chat_bubble_outline),
                        title: Text(_comments[index]['body'] as String)))),
            TextField(
                controller: _text,
                enabled: !_busy,
                maxLines: 3,
                maxLength: 10000,
                decoration:
                    const InputDecoration(labelText: 'Write a comment')),
            Wrap(spacing: 12, children: [
              TextButton(
                  onPressed: _busy ? null : _load,
                  child: const Text('Refresh comments')),
              FilledButton(
                  onPressed: _busy ? null : _post,
                  child: const Text('Post comment')),
            ]),
          ])));
}
