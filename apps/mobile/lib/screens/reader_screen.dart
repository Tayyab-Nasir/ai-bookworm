import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../auth.dart';
import '../api.dart';
import '../models.dart';

/// Reader + lightweight editor. Reads the chapter's current document version
/// through the Supabase client (RLS gates access; the /v1 API only exposes
/// operations). Edits go through POST /v1/chapters/:id/operations with
/// expectedVersion — a 409 means someone else saved first, so we reload.
class ReaderScreen extends StatefulWidget {
  const ReaderScreen({
    super.key,
    required this.auth,
    required this.chapter,
    required this.workspaceId,
  });

  final AuthState auth;
  final Chapter chapter;
  final String workspaceId;

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  final _text = TextEditingController();
  List<Map<String, dynamic>> _comments = const [];
  int _version = 0;
  bool _editing = false;
  bool _loading = true;
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
    setState(() => _loading = true);
    try {
      final sb = Supabase.instance.client;
      final rows = await sb
          .from('document_versions')
          .select('version_number, plain_text')
          .eq('chapter_id', widget.chapter.id)
          .order('version_number', ascending: false)
          .limit(1);
      final row = rows.isEmpty ? null : rows.first;
      final comments = await widget.auth.api?.listComments(
              widget.workspaceId, 'chapter', widget.chapter.id) ??
          const <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() {
        _version = (row?['version_number'] as num?)?.toInt() ?? 0;
        if (!_editing) _text.text = row?['plain_text'] as String? ?? '';
        _comments = comments;
        _loading = false;
        _error = null;
      });
    } on Exception catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _save() async {
    final api = widget.auth.api;
    if (api == null) return;
    try {
      final newVersion = await api.applyChapterOperation(
        widget.chapter.id,
        operationId: 'mobile-${DateTime.now().microsecondsSinceEpoch}',
        type: 'replace_text',
        target: {'chapterId': widget.chapter.id},
        payload: {'text': _text.text},
        expectedVersion: _version,
      );
      if (mounted) {
        setState(() {
          _version = newVersion;
          _editing = false;
        });
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Saved v$newVersion')));
      }
    } on ApiError catch (e) {
      if (!mounted) return;
      if (e.status == 409) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Chapter changed elsewhere — reloading latest')));
        await _load();
      } else {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _addComment() async {
    final controller = TextEditingController();
    final body = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Comment'),
        content: TextField(
            controller: controller,
            autofocus: true,
            maxLines: 3,
            decoration: const InputDecoration(hintText: 'Write a comment…')),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, controller.text.trim()),
              child: const Text('Post')),
        ],
      ),
    );
    if (body == null || body.isEmpty) return;
    await widget.auth.api
        ?.createComment(widget.workspaceId, 'chapter', widget.chapter.id, body);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.chapter.title),
        actions: [
          IconButton(
            icon: const Icon(Icons.comment_outlined),
            onPressed: _addComment,
          ),
          IconButton(
            icon: Icon(_editing ? Icons.close : Icons.edit),
            onPressed: () => setState(() => _editing = !_editing),
          ),
          if (_editing)
            IconButton(icon: const Icon(Icons.save), onPressed: _save),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                if (_error != null) Text(_error!),
                Expanded(
                  child: _editing
                      ? Padding(
                          padding: const EdgeInsets.all(12),
                          child: TextField(
                            controller: _text,
                            maxLines: null,
                            expands: true,
                            keyboardType: TextInputType.multiline,
                            decoration: const InputDecoration.collapsed(
                                hintText: 'Write…'),
                          ),
                        )
                      : SingleChildScrollView(
                          padding: const EdgeInsets.all(16),
                          child: Text(_text.text.isEmpty
                              ? '(empty chapter)'
                              : _text.text),
                        ),
                ),
                if (_comments.isNotEmpty)
                  SizedBox(
                    height: 160,
                    child: ListView(
                      children: [
                        for (final c in _comments)
                          ListTile(
                            dense: true,
                            leading: const Icon(Icons.chat_bubble_outline,
                                size: 18),
                            title: Text(c['body'] as String? ?? ''),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }
}
